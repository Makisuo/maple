import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { lstat, rm, statfs } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { CHDB_VERSION, MAPLE_VERSION } from "../../version"
import { SCHEMA_FINGERPRINT } from "../serve"
import {
	acquireCheckpointPin,
	checkpointPinsRoot,
	releaseCheckpointPin,
	resolveCheckpoint,
	withMaintenanceLock,
	withRestoredCheckpoint,
	type CheckpointManifest,
} from "../checkpoints"
import { durableJson, durableRename, durableWrite, syncDirectory, syncTree } from "../durable-files"
import { type ArchiveTuning, tuningRecord } from "./config"
import {
	type ArchiveShardRecord,
	type ArchiveGenerationManifest,
	parseArchiveActivePointer,
	readArchiveGenerationManifest,
} from "./manifest"
import {
	activePointerPath,
	archiveRoot,
	assertArchiveRootSeparate,
	assertNoSymlink,
	assertRealDirectory,
	assertRealFile,
	buildingGenerationRoot,
	buildingRoot,
	catalogPath,
	ensurePrivateDirectory,
	generationManifestPath,
	generationRoot,
	newArchiveGenerationId,
	nextMidnightUtc,
	rangeRoot,
	validateRangeDate,
} from "./paths"
import { type ArchiveSignal, archiveSignal } from "./signals"
import { COMPLEX_DIGEST_ALGORITHM, exportSignalShards, type WrittenShard } from "./export"
import {
	advancePhase,
	archiveCompletedOperation,
	assertPointerConsistent,
	operationDir,
	ownedPathsFor,
	phaseAtLeast,
	readActiveOperation,
	resolveBaseActiveGenerationId,
	writeInitialIntent,
	type ArchiveOperationIntent,
	type ArchiveOperationPhase,
} from "./journal"
import { rebuildCatalog } from "./listing"

// Archive generation write, validation, promotion, and reconciliation.
//
// One archive operation seals a fixed UTC day for one signal by exporting it
// from a restored checkpoint into bounded Parquet shards, validating every
// shard, publishing an authoritative manifest, and atomically selecting the new
// generation through the active pointer. Late arrivals create a new generation
// that supersedes the old; the old generation is retained, never deleted and
// never scanned for TraceId deduplication.
//
// The whole operation holds the checkpoint maintenance lock so it cannot overlap
// checkpoint creation, restore, reset, or another archive operation. It pins
// the source checkpoint inside the lock so retention cannot delete it between
// resolution and export. Uncertain or incomplete state is preserved and
// reported; only provably owned `building/<gen>/` temporary output is removed.

export interface ArchiveGenerationFaults {
	readonly afterPinAcquired?: () => void | Promise<void>
	readonly afterScratchRestored?: () => void | Promise<void>
	readonly afterBuildingCreated?: () => void | Promise<void>
	readonly afterShardsWritten?: () => void | Promise<void>
	readonly afterFirstDurableShard?: () => void
	readonly afterValidationComplete?: () => void | Promise<void>
	readonly afterManifestWritten?: () => void | Promise<void>
	readonly afterGenerationRenamed?: () => void | Promise<void>
	readonly afterGenerationPromoted?: () => void | Promise<void>
	readonly afterCatalogAppended?: () => void | Promise<void>
	readonly afterPinRemovedBeforeJournal?: () => void | Promise<void>
	readonly afterPinReleased?: () => void | Promise<void>
	// Pre-boundary seams for crash-safety validation (Gate 3). The after-* hooks
	// above fire AFTER a durable boundary completes; they cannot inject a crash
	// DURING the boundary (e.g. between a durable write and the journal advance
	// that records it). These pre-boundary seams let the crash harness SIGKILL at
	// the exact intra-boundary points where unwinding or the finally would mask a
	// real crash. They are a committed test seam, not a production switch.
	readonly beforeIntentDurable?: () => void | Promise<void>
	readonly beforePinAcquired?: () => void | Promise<void>
	readonly beforeScratchAllocated?: () => void | Promise<void>
	readonly beforeBuildingCreated?: () => void | Promise<void>
	readonly beforeManifestDurable?: () => void | Promise<void>
	readonly beforeGenerationPromoted?: () => void | Promise<void>
	readonly beforeActivePointerUpdated?: () => void | Promise<void>
	readonly beforeCatalogAppended?: () => void | Promise<void>
	readonly beforePinReleased?: () => void | Promise<void>
	readonly beforeScratchRemoved?: () => void | Promise<void>
	readonly beforeOperationArchived?: () => void | Promise<void>
}

export interface ArchiveGenerationResult {
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly shardCount: number
	readonly archivedRowCount: number
	readonly superseded: string | null
}

const checkpointFingerprint = (manifest: CheckpointManifest): string =>
	`${manifest.checkpointId}:${manifest.createdAt}:${manifest.backupBytes}`

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

const toShardRecord = (shard: WrittenShard): ArchiveShardRecord => ({
	name: shard.name,
	rowCount: shard.rowCount,
	minEventTimeUnixNano: shard.minEventTimeUnixNano,
	maxEventTimeUnixNano: shard.maxEventTimeUnixNano,
	sha256: shard.sha256,
	bytes: shard.bytes,
	columns: shard.columns,
	complexDigest: shard.complexDigest,
	complexDigestAlgorithm: COMPLEX_DIGEST_ALGORITHM,
})

/**
 * Refuse to start if the archive volume does not have at least
 * `minFreeSpaceReserve` bytes free. Machine conditions can change after
 * calibration, so this runs at operation time, not just at calibration.
 */
/**
 * Preflight that the destination volume has enough free space for the reserve
 * PLUS the predicted working bytes (scratch restore + Parquet output). If the
 * archive root does not yet exist, check the volume of the closest existing
 * ancestor (the containing volume), not skip the check. `archiveDir` and
 * `tuning.archiveDir` must be the same path (the output destination).
 */
const preflightFreeSpace = async (
	archiveDir: string,
	tuningArchiveDir: string,
	minFreeSpaceReserve: number,
	estimatedWorkingBytes: number,
): Promise<void> => {
	if (resolve(archiveDir) !== resolve(tuningArchiveDir)) {
		throw new Error(
			`archive directory mismatch: output target ${archiveDir} != tuning.archiveDir ${tuningArchiveDir}`,
		)
	}
	// Find the closest existing ancestor to statfs (handles a not-yet-created root).
	let statPath = archiveDir
	let climbs = 0
	while (!existsSync(statPath) && climbs < 64) {
		statPath = resolve(statPath, "..")
		climbs++
	}
	if (!existsSync(statPath)) {
		throw new Error(`cannot determine volume for archive dir ${archiveDir} (no existing ancestor)`)
	}
	const info = await statfs(statPath)
	const free = info.bavail * info.bsize
	const required = minFreeSpaceReserve + estimatedWorkingBytes
	if (free < required) {
		throw new Error(
			`archive volume has ${free} bytes free, below the required ${required} bytes ` +
				`(reserve ${minFreeSpaceReserve} + working ${estimatedWorkingBytes}); ` +
				`free space or recalibrate`,
		)
	}
}

/**
 * Seal one UTC day of one signal into a new archive generation.
 *
 * Crash-safe via a durable operation journal (Gate 3). Each boundary below is
 * recorded as a phase BEFORE the next destructive step, so a SIGKILL at any
 * point leaves a reconcilable record. The journal is written BEFORE pin
 * acquisition (closing the orphan-pin window) and uses deterministic identities
 * (pinId, scratchSubdir, generationId) so reconciliation knows exactly what an
 * interrupted operation owned.
 *
 * The lifecycle, inside the maintenance lock:
 *   1. reconcile any existing active operation (see {@link reconcileArchiveGeneration});
 *   2. resolve checkpoint; read the current active pointer as the CAS base;
 *   3. write the initial intent (phase "intent");
 *   4. acquire the deterministic pin (phase "pin-acquired");
 *   5. allocate deterministic scratch + restore (phase "scratch-allocated"→"restored");
 *   6. create owned building (phase "building-created");
 *   7. export + validate shards (phase "shards-written");
 *   8. write manifest inside building/ (phase "manifest-written");
 *   9. rename building → final generation (phase "promoted");
 *  10. CAS pointer update (phase "pointer-complete");
 *  11. rebuild catalog idempotently (phase "catalog-complete");
 *  12. release owned pin (phase "pin-released");
 *  13. remove owned scratch (phase "scratch-removed");
 *  14. archive the operation journal to operations/completed/ (phase "complete").
 *
 * A thrown error still runs a `finally` that releases the pin and removes owned
 * building/scratch ONLY when provably owned; a real SIGKILL does not run that
 * finally, which is exactly why the journal — not the finally — is authoritative.
 */
export const createArchiveGeneration = async (
	dataDir: string,
	archiveDir: string,
	signalName: string,
	rangeDate: string,
	tuning: ArchiveTuning,
	checkpointSelector: "current" | "previous" | string = "current",
	faults: ArchiveGenerationFaults = {},
): Promise<ArchiveGenerationResult> => {
	validateRangeDate(rangeDate)
	assertArchiveRootSeparate(archiveDir, dataDir)
	if (resolve(archiveDir) !== resolve(tuning.archiveDir)) {
		throw new Error(
			`archive directory mismatch: invocation ${resolve(archiveDir)} != configured ${resolve(tuning.archiveDir)}`,
		)
	}
	await assertReconciliationRoots(dataDir, archiveDir, tuning.scratchRoot)
	const signal = archiveSignal(signalName)
	const estimatedWorkingBytes = tuning.targetChunkBytes
	const generationId = newArchiveGenerationId()
	const operationId = randomUUID()
	// Deterministic identities recorded in the journal BEFORE allocation.
	const pinId = randomUUID()
	const pinPurpose = `archive:${generationId}`
	const scratchSubdir = `archive-${operationId}`

	return withMaintenanceLock(dataDir, operationId, async () => {
		// Step 1: reconcile any prior interrupted operation before allocating a
		// new one. This is the crash-recovery entry point.
		await reconcileArchiveGeneration(dataDir, archiveDir, tuning.scratchRoot, faults)
		// Step 2: resolve checkpoint; read the CAS base (current active pointer).
		const resolved = await resolveCheckpoint(dataDir, checkpointSelector)
		const baseActiveGenerationId = resolveBaseActiveGenerationId(archiveDir, signal.name, rangeDate)
		// Step 3: write the initial intent BEFORE the pin or any allocation. A
		// crash here leaves only the journal; reconciliation quarantines it.
		await faults.beforeIntentDurable?.()
		await writeInitialIntent({
			archiveDir,
			operationId,
			generationId,
			signal: signal.name,
			rangeStart: rangeDate,
			checkpointId: resolved.checkpointId,
			dataDir,
			scratchRoot: tuning.scratchRoot,
			pinId,
			pinPurpose,
			scratchSubdir,
			baseActiveGenerationId,
		})
		// Now that free space can be assessed (the archive root exists), preflight.
		await preflightFreeSpace(
			archiveDir,
			tuning.archiveDir,
			tuning.minFreeSpaceReserve,
			estimatedWorkingBytes,
		)

		// Step 4: acquire the deterministic pin. The journal already names pinId,
		// so a crash between pin-write and the phase advance is reconcilable.
		await faults.beforePinAcquired?.()
		const pinPath = await acquireCheckpointPin(dataDir, resolved.checkpointId, pinPurpose, pinId)
		await advancePhase(archiveDir, operationId, "pin-acquired")
		await faults.afterPinAcquired?.()

		try {
			// Steps 5–7: scratch restore + export. The beforeRestore seam records
			// "scratch-allocated" after the owned scratch dir is created but before
			// restore; "restored" after the db is usable.
			return await withRestoredCheckpoint(
				resolved,
				{
					scratchRoot: tuning.scratchRoot,
					scratchSubdir,
					cleanup: "never",
					beforeRestore: async () => {
						await faults.beforeScratchAllocated?.()
						await advancePhase(archiveDir, operationId, "scratch-allocated")
					},
				},
				async ({ db, manifest: checkpointManifest }) => {
					await advancePhase(archiveDir, operationId, "restored")
					await faults.afterScratchRestored?.()
					const dayEndExclusiveIso = nextMidnightUtc(rangeDate)
					const sourceRowCount = countSignalRowsForDay(db, signal, rangeDate)

					// Step 6: create owned building.
					const building = buildingGenerationRoot(archiveDir, generationId)
					await faults.beforeBuildingCreated?.()
					await ensureOwnedBuilding(archiveDir, building)
					await advancePhase(archiveDir, operationId, "building-created")
					await faults.afterBuildingCreated?.()

					// Step 7: export + validate shards.
					const shardsDir = join(building, "shards")
					await ensurePrivateDirectory(shardsDir, archiveRoot(archiveDir))
					const writtenShards = exportSignalShards(db, signal, rangeDate, shardsDir, {
						writerThreads: tuning.writerThreads,
						rowGroupRows: tuning.rowGroupRows,
						maxShardRows: tuning.maxShardRows,
						maxShardBytes: tuning.maxShardBytes,
						afterShardValidated: (() => {
							let seen = false
							return () => {
								if (!seen) {
									seen = true
									faults.afterFirstDurableShard?.()
								}
							}
						})(),
					})
					await syncTree(shardsDir)
					const archivedRowCount = writtenShards.reduce((sum, s) => sum + s.rowCount, 0)
					if (archivedRowCount !== sourceRowCount) {
						throw new Error(
							`archive row-count mismatch for ${signal.name} ${rangeDate}: source ${sourceRowCount}, ` +
								`archived ${archivedRowCount}`,
						)
					}
					await advancePhase(archiveDir, operationId, "shards-written")
					await faults.afterShardsWritten?.()
					await faults.afterValidationComplete?.()

					// Step 8: manifest (written inside building/ by promote).
					const manifest: ArchiveGenerationManifest = {
						formatVersion: 2,
						generationId,
						signal: signal.name,
						rangeStart: rangeDate,
						rangeEndExclusive: dayEndExclusiveIso,
						checkpointId: resolved.checkpointId,
						checkpointManifestFingerprint: checkpointFingerprint(checkpointManifest),
						createdAt: new Date().toISOString(),
						mapleVersion: MAPLE_VERSION,
						chdbVersion: CHDB_VERSION,
						schemaFingerprint: SCHEMA_FINGERPRINT,
						sourceRowCount,
						archivedRowCount,
						tuning: tuningRecord(tuning),
						tuningConfigName: null,
						shards: writtenShards.map(toShardRecord),
					}
					// Step 9: promote building → final generation + manifest.
					await promoteGeneration(
						archiveDir,
						signal.name,
						rangeDate,
						generationId,
						manifest,
						building,
						{
							...faults,
							afterManifestWritten: async () => {
								const manifestPath = join(building, "manifest.json")
								const manifestSha256 = sha256File(manifestPath)
								await advancePhase(
									archiveDir,
									operationId,
									"manifest-written",
									manifestSha256,
								)
								await faults.afterManifestWritten?.()
							},
						},
					)
					await advancePhase(archiveDir, operationId, "promoted")
					// Step 10: CAS pointer update.
					const superseded = await selectActiveGeneration(
						archiveDir,
						signal.name,
						rangeDate,
						generationId,
						baseActiveGenerationId,
						faults,
					)
					await advancePhase(archiveDir, operationId, "pointer-complete")
					// Step 11: rebuild catalog idempotently from manifests (never a
					// blind append — a duplicate after recovery would corrupt the index).
					await faults.beforeCatalogAppended?.()
					await rebuildCatalog(archiveDir, signal.name)
					await advancePhase(archiveDir, operationId, "catalog-complete")
					await faults.afterCatalogAppended?.()
					// Steps 12–14: release the owned pin, remove owned scratch, then
					// archive the completed journal. Each is a recorded durable boundary
					// so a SIGKILL at any of them is reconcilable. These run on the happy
					// path INSIDE the journal.
					await releaseCheckpointPin(dataDir, resolved.checkpointId, pinPath, pinPurpose)
					await faults.afterPinRemovedBeforeJournal?.()
					await advancePhase(archiveDir, operationId, "pin-released")
					await faults.afterPinReleased?.()
					await faults.beforeScratchRemoved?.()
					await removeOwnedScratch(tuning.scratchRoot, scratchSubdir)
					await advancePhase(archiveDir, operationId, "scratch-removed")
					// Advance to "complete" BEFORE archiving the journal: archiving MOVES
					// the op dir out of active/, so a phase advance after it would read a
					// path that no longer exists. The "complete" phase is the last record
					// written while the op is still in active/; archiving then retires it.
					await advancePhase(archiveDir, operationId, "complete")
					await faults.beforeOperationArchived?.()
					await archiveCompletedOperation(archiveDir, operationId)
					return {
						generationId,
						signal: signal.name,
						rangeStart: rangeDate,
						shardCount: writtenShards.length,
						archivedRowCount,
						superseded,
					}
				},
			)
		} finally {
			// Deliberately no durable-state mutation here. Throw and SIGKILL must
			// leave the same journal-described topology; reconciliation is the sole
			// authority for pin release, quarantine, and scratch cleanup.
		}
	})
}

const countSignalRowsForDay = (
	db: { query: (sql: string, format?: string) => string },
	signal: ArchiveSignal,
	rangeDate: string,
): number => {
	// Use toDate() equality, not a toDateTime64: chDB's bundled ClickHouse
	// miscounts aggregate count() over a toDateTime64-vs-DateTime predicate.
	const sql = `SELECT count() FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}'`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Strictly read the previous active pointer and return its generation id, binding
 * the pointer's recorded signal/range to its on-disk location so a pointer
 * copied or moved to the wrong range cannot be silently superseded (H-7).
 * Throws on a malformed, mismatched, or unreadable pointer.
 */
const readPreviousPointerGenerationId = (
	pointerPath: string,
	expectedSignal: string,
	expectedRange: string,
): string | null => {
	const parsed = JSON.parse(readFileSync(pointerPath, "utf8")) as unknown
	const pointer = parseArchiveActivePointer(parsed)
	if (pointer.signal !== expectedSignal) {
		throw new Error(
			`archive active pointer signal mismatch at ${pointerPath}: ` +
				`expected ${expectedSignal}, recorded ${pointer.signal}`,
		)
	}
	if (pointer.rangeStart !== expectedRange) {
		throw new Error(
			`archive active pointer range mismatch at ${pointerPath}: ` +
				`expected ${expectedRange}, recorded ${pointer.rangeStart}`,
		)
	}
	return pointer.generationId
}

/** Parse a JSONEachRow count result (newline-delimited objects, not a JSON array). */
const parseCount = (text: string): number => {
	const rows = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const row = rows[0]
	if (!row) return 0
	const value = row["count()"] ?? row.count
	const count = typeof value === "number" ? value : Number(value ?? 0)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid count result: ${value}`)
	return count
}

const ensureOwnedBuilding = async (archiveDir: string, building: string): Promise<void> => {
	const root = buildingRoot(archiveDir)
	// Refuse a symlinked building root or any symlinked ancestor beneath the
	// archive root before creating anything (C-1): mkdir -p would otherwise
	// silently create the tree under a symlink target outside the archive root.
	if (existsSync(root)) {
		await assertNoSymlink(archiveDir, root, "archive building root")
		await assertRealDirectory(root, "archive building root")
	}
	await ensurePrivateDirectory(root, archiveRoot(archiveDir))
	if (existsSync(building)) {
		throw new Error(`archive building generation already exists; refusing to overwrite: ${building}`)
	}
	await ensurePrivateDirectory(building, archiveRoot(archiveDir))
	await assertNoSymlink(archiveDir, building, "archive building generation")
}

/**
 * Move the validated building generation into its final location and write its
 * manifest there. This is the "promote" boundary: after it returns, the
 * generation exists at its final path with its manifest, but the active pointer
 * does NOT yet select it. A separate {@link selectActiveGeneration} call flips
 * the pointer — the two are split so the journal can record each as a distinct
 * durable boundary (promoted → pointer-complete), making promotion crash-safe.
 *
 * Returns the previously-active generation id (the CAS base), or null. The old
 * generation directory is retained (never deleted).
 *
 * Exported for filesystem-level testing of promotion without a restored chDB.
 */
export const promoteGeneration = async (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	manifestValue: ArchiveGenerationManifest,
	building: string,
	faults: ArchiveGenerationFaults = {},
): Promise<void> => {
	const finalGeneration = generationRoot(archiveDir, signal, rangeDate, generationId)
	if (existsSync(finalGeneration)) {
		await assertNoSymlink(archiveDir, finalGeneration, "archive generation")
		throw new Error(`archive generation already exists; refusing to overwrite: ${finalGeneration}`)
	}
	const range = rangeRoot(archiveDir, signal, rangeDate)
	const generationsRootAbs = generationsRootPath(archiveDir, signal, rangeDate)
	// Refuse symlinked ancestors on every path we are about to create or write
	// (C-1): the signal/range/generations chain is operator-controlled on disk.
	await ensurePrivateDirectory(range, archiveRoot(archiveDir))
	await assertNoSymlink(archiveDir, range, "archive range")
	await ensurePrivateDirectory(generationsRootAbs, archiveRoot(archiveDir))
	await assertNoSymlink(archiveDir, generationsRootAbs, "archive generations root")
	// The complete manifest becomes durable INSIDE building before publication.
	// The subsequent directory rename therefore publishes shards + manifest as
	// one atomic unit; no final generation can exist without its manifest.
	const manifestPath = join(building, "manifest.json")
	await assertNoSymlink(archiveDir, manifestPath, "archive building manifest")
	await faults.beforeManifestDurable?.()
	await durableJson(manifestPath, manifestValue)
	await syncDirectory(dirname(manifestPath))
	await faults.afterManifestWritten?.()
	await faults.beforeGenerationPromoted?.()
	await durableRename(building, finalGeneration)
	await syncDirectory(dirname(finalGeneration))
	await faults.afterGenerationRenamed?.()
}

/**
 * Atomically select `generationId` through the active pointer for (signal,
 * rangeDate). CAS-guarded: the pointer must currently equal `baseGenerationId`
 * (the recorded base) OR already select `generationId` (idempotent replay).
 * Anything else means concurrent activity moved the pointer and a blind
 * overwrite would clobber it — fail closed. Returns the superseded generation
 * id (the prior pointer value), or null.
 *
 * Exported for filesystem-level testing of pointer atomicity.
 */
export const selectActiveGeneration = async (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	baseGenerationId: string | null,
	faults: ArchiveGenerationFaults = {},
): Promise<string | null> => {
	const pointerPath = activePointerPath(archiveDir, signal, rangeDate)
	await assertNoSymlink(archiveDir, pointerPath, "archive active pointer")
	let current: string | null = null
	let superseded: string | null = null
	if (existsSync(pointerPath)) {
		await assertRealFile(pointerPath, "archive active pointer")
		superseded = readPreviousPointerGenerationId(pointerPath, signal, rangeDate)
		current = superseded
	}
	// CAS: the pointer must still match the recorded base, or already select the
	// intended generation (idempotent). Concurrent supersession fails closed.
	if (current !== baseGenerationId && current !== generationId) {
		throw new Error(
			`archive active pointer no longer matches base for ${signal}/${rangeDate}: ` +
				`expected base ${baseGenerationId}, now ${current} (refusing to clobber)`,
		)
	}
	// Idempotent: if the pointer already selects this generation, nothing to do.
	if (current === generationId) return superseded
	await faults.beforeActivePointerUpdated?.()
	await durableWrite(
		pointerPath,
		`${JSON.stringify({
			formatVersion: 1,
			generationId,
			signal,
			rangeStart: rangeDate,
			selectedAt: new Date().toISOString(),
		})}\n`,
	)
	await syncDirectory(dirname(pointerPath))
	await faults.afterGenerationPromoted?.()
	return superseded
}

const generationsRootPath = (archiveDir: string, signal: string, rangeDate: string): string =>
	join(rangeRoot(archiveDir, signal, rangeDate), "generations")

/**
 * Append a generation to the per-signal catalog. Exported for testing catalog
 * append durability and rebuild.
 */
export const appendCatalog = async (
	archiveDir: string,
	signal: string,
	manifest: ArchiveGenerationManifest,
	faults: ArchiveGenerationFaults = {},
): Promise<void> => {
	const path = catalogPath(archiveDir, signal)
	// Refuse a symlinked catalog (C-1): a symlinked catalog.jsonl could point
	// outside the archive root and be overwritten by this append.
	if (existsSync(path)) await assertRealFile(path, "archive catalog")
	else await assertNoSymlink(archiveDir, path, "archive catalog")
	const existing = existsSync(path) ? `${readFileSync(path, "utf8")}` : ""
	const line = `${JSON.stringify({
		formatVersion: 1,
		generationId: manifest.generationId,
		signal: manifest.signal,
		rangeStart: manifest.rangeStart,
		checkpointId: manifest.checkpointId,
		archivedRowCount: manifest.archivedRowCount,
		shardCount: manifest.shards.length,
		createdAt: manifest.createdAt,
	})}\n`
	// Catalog append is a durable full rewrite so the appended line is fsynced.
	// A truncated final line is ignored on rebuild (see catalog rebuild).
	await durableWrite(path, existing + line)
	await syncDirectory(dirname(path))
	await faults.afterCatalogAppended?.()
}

/**
 * Remove the owned deterministic scratch subdirectory the operation allocated.
 * Only the exact journal-named subdir beneath scratchRoot is removed; anything
 * else (other operations' scratch, the scratch root itself) is over-retained.
 */
const removeOwnedScratch = async (scratchRoot: string, scratchSubdir: string): Promise<void> => {
	if (!existsSync(scratchRoot)) return
	await assertFilesystemPathNoSymlinks(scratchRoot, "scratch root")
	const scratchInfo = await lstat(resolve(scratchRoot))
	if (scratchInfo.isSymbolicLink() || !scratchInfo.isDirectory()) {
		throw new Error(`refusing unsafe scratch root: ${scratchRoot}`)
	}
	const owned = join(resolve(scratchRoot), scratchSubdir)
	if (!existsSync(owned)) return
	// Containment: the subdir must be a direct child of the scratch root.
	const rel = relative(resolve(scratchRoot), resolve(owned))
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(sep)) {
		throw new Error(`refusing to remove scratch path outside its root: ${owned}`)
	}
	await assertFilesystemPathNoSymlinks(owned, "owned scratch directory")
	const ownedInfo = await lstat(owned)
	if (ownedInfo.isSymbolicLink() || !ownedInfo.isDirectory()) {
		throw new Error(`refusing unsafe owned scratch directory: ${owned}`)
	}
	// Restored ClickHouse stores legitimately contain internal table symlinks.
	// fs.rm removes those links as directory entries; it does not traverse their
	// targets. The security boundary is therefore the real configured root and
	// exact real operation subdirectory checked above.
	await rm(owned, { recursive: true, force: true })
	await syncDirectory(resolve(scratchRoot))
}

const assertFilesystemPathNoSymlinks = async (path: string, label: string): Promise<void> => {
	const absolute = resolve(path)
	if (!existsSync(absolute)) return
	const info = await lstat(absolute)
	if (info.isSymbolicLink()) throw new Error(`refusing symlink in ${label}: ${absolute}`)
}

/**
 * Reconcile any active (interrupted) archive operation, driving it to its exact
 * intended state or failing closed (preserving everything; D-004). Called at the
 * top of {@link createArchiveGeneration} inside the maintenance lock, BEFORE
 * allocating a new operation.
 *
 * Policy:
 * - At most one active operation is permitted; more is ambiguous (fail closed).
 * - A pre-publication op (phase before "promoted") owns no published generation.
 *   Its incomplete building output is QUARANTINED (retained, not deleted), its
 *   owned scratch removed, its owned pin released, and the op marked "aborted".
 * - A post-promotion op (phase "promoted" onward) has a published generation.
 *   Reconciliation verifies it, finishes the pointer/catalog if needed, releases
 *   the owned pin, removes owned scratch, and archives the op to "complete".
 * - Pin absence is success only at a phase where release was already authorized
 *   ("pin-released" onward). Otherwise it is an identity/topology error.
 *
 * Reconciliation is idempotent: running it twice converges to the same state.
 */
export const reconcileArchiveGeneration = async (
	dataDir: string,
	archiveDir: string,
	scratchRoot: string,
	faults: ArchiveGenerationFaults = {},
): Promise<void> => {
	void faults
	await assertReconciliationRoots(dataDir, archiveDir, scratchRoot)
	const active = readActiveOperation(archiveDir, dataDir, scratchRoot)
	if (active === null) return
	const { operationId, intent } = active

	// Validate the recorded topology against reality before acting. The owned
	// paths must be consistent with the archive root and identities.
	const { finalGeneration, building } = ownedPathsFor(intent)
	await validateReconciliationTopology(dataDir, archiveDir, intent, finalGeneration, building)
	const promoted = existsSync(finalGeneration)
	const finalManifestPath = generationManifestPath(
		archiveDir,
		intent.signal,
		intent.rangeStart,
		intent.generationId,
	)
	const manifestAtFinal = existsSync(finalManifestPath)

	if (phaseAtLeast(intent.phase, "complete")) {
		// Already complete; just ensure the journal is archived out of active/.
		await archiveCompletedOperation(archiveDir, operationId)
		return
	}
	if (phaseAtLeast(intent.phase, "aborted")) {
		// Already aborted; the op dir should have been quarantined. If it's still
		// in active/, fail closed (ambiguous).
		throw new Error(
			`aborted archive operation still in active dir: ${operationDir(archiveDir, operationId)}`,
		)
	}

	if (promoted && !manifestAtFinal) {
		throw new Error(
			`archive operation published a generation without a manifest; preserving journal and final state: ${finalGeneration}`,
		)
	}
	if (promoted && !phaseAtLeast(intent.phase, "manifest-written")) {
		throw new Error(
			`archive operation final generation exists before manifest-written phase: ${finalGeneration}`,
		)
	}
	if (!promoted && phaseAtLeast(intent.phase, "promoted")) {
		throw new Error(
			`archive operation phase ${intent.phase} requires its final generation: ${finalGeneration}`,
		)
	}

	// Pre-publication: the generation was never promoted. Quarantine building
	// output, remove owned scratch, release owned pin, mark aborted.
	if (!promoted) {
		await reconcilePrePublication(dataDir, archiveDir, intent, building, "aborted")
		return
	}

	// Post-promotion: a complete generation + manifest was published. Finish the
	// remaining steps idempotently.
	await verifyPublishedGeneration(archiveDir, intent)
	await reconcilePostPromotion(dataDir, archiveDir, intent, operationId)
}

const validateReconciliationTopology = async (
	dataDir: string,
	archiveDir: string,
	intent: ArchiveOperationIntent,
	finalGeneration: string,
	building: string,
): Promise<void> => {
	for (const [path, label] of [
		[building, "archive building generation"],
		[finalGeneration, "archive final generation"],
	] as const) {
		if (!existsSync(path)) continue
		await assertNoSymlink(archiveDir, path, label)
		await assertRealDirectory(path, label)
	}
	if (existsSync(building) && existsSync(finalGeneration)) {
		throw new Error("archive operation has both building and final generation state")
	}
	const ownedScratch = join(resolve(intent.scratchRoot), intent.scratchSubdir)
	if (existsSync(intent.scratchRoot)) {
		await assertFilesystemPathNoSymlinks(intent.scratchRoot, "scratch root")
	}
	if (existsSync(ownedScratch)) {
		await assertFilesystemPathNoSymlinks(ownedScratch, "owned scratch directory")
		const info = await lstat(ownedScratch)
		if (!info.isDirectory()) throw new Error(`owned scratch path is not a directory: ${ownedScratch}`)
	}
	await validateOwnedPinState(dataDir, intent)
}

const validateOwnedPinState = async (dataDir: string, intent: ArchiveOperationIntent): Promise<void> => {
	const expectedPinPath = join(checkpointPinsRoot(dataDir), intent.checkpointId, `${intent.pinId}.json`)
	if (!existsSync(expectedPinPath)) {
		const absenceAuthorized = intent.phase === "intent" || phaseAtLeast(intent.phase, "catalog-complete")
		if (!absenceAuthorized) {
			throw new Error(
				`archive operation pin is missing before release was authorized: ${expectedPinPath} (phase ${intent.phase})`,
			)
		}
		return
	}
	await assertFilesystemPathNoSymlinks(expectedPinPath, "archive operation pin")
	await assertRealFile(expectedPinPath, "archive operation pin")
	const raw = JSON.parse(readFileSync(expectedPinPath, "utf8")) as Record<string, unknown>
	if (
		raw.formatVersion !== 1 ||
		raw.pinId !== intent.pinId ||
		raw.checkpointId !== intent.checkpointId ||
		raw.purpose !== intent.pinPurpose
	) {
		throw new Error(`archive operation pin identity or purpose mismatch: ${expectedPinPath}`)
	}
}

const assertReconciliationRoots = async (
	dataDir: string,
	archiveDir: string,
	scratchRoot: string,
): Promise<void> => {
	for (const [label, path] of [
		["archive", resolve(archiveDir)],
		["data", resolve(dataDir)],
		["scratch", resolve(scratchRoot)],
	] as const) {
		if (!existsSync(path)) continue
		await assertFilesystemPathNoSymlinks(path, `${label} root`)
		const info = await lstat(path)
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`refusing unsafe ${label} root: ${path}`)
		}
	}
}

const verifyPublishedGeneration = async (
	archiveDir: string,
	intent: ArchiveOperationIntent,
): Promise<ArchiveGenerationManifest> => {
	const finalGeneration = generationRoot(archiveDir, intent.signal, intent.rangeStart, intent.generationId)
	await assertNoSymlink(archiveDir, finalGeneration, "archive final generation")
	await assertRealDirectory(finalGeneration, "archive final generation")
	const manifestPath = generationManifestPath(
		archiveDir,
		intent.signal,
		intent.rangeStart,
		intent.generationId,
	)
	await assertNoSymlink(archiveDir, manifestPath, "archive final manifest")
	await assertRealFile(manifestPath, "archive final manifest")
	const actualManifestSha256 = sha256File(manifestPath)
	if (actualManifestSha256 !== intent.manifestSha256) {
		throw new Error(
			`archive final manifest SHA-256 mismatch: journal ${intent.manifestSha256}, actual ${actualManifestSha256}`,
		)
	}
	const manifest = readArchiveGenerationManifest(
		archiveDir,
		intent.signal,
		intent.rangeStart,
		intent.generationId,
	)
	if (manifest.checkpointId !== intent.checkpointId) {
		throw new Error(
			`archive final manifest checkpoint mismatch: journal ${intent.checkpointId}, manifest ${manifest.checkpointId}`,
		)
	}
	for (const shard of manifest.shards) {
		const shardPath = join(finalGeneration, "shards", shard.name)
		await assertNoSymlink(archiveDir, shardPath, `archive shard ${shard.name}`)
		await assertRealFile(shardPath, `archive shard ${shard.name}`)
		const actualBytes = statSync(shardPath).size
		if (actualBytes !== shard.bytes) {
			throw new Error(
				`archive shard ${shard.name} byte size mismatch: manifest ${shard.bytes}, actual ${actualBytes}`,
			)
		}
		const actualSha256 = sha256File(shardPath)
		if (actualSha256 !== shard.sha256) {
			throw new Error(
				`archive shard ${shard.name} SHA-256 mismatch: manifest ${shard.sha256}, actual ${actualSha256}`,
			)
		}
	}
	return manifest
}

/**
 * Reconcile a pre-publication operation: the generation was never durably
 * published. Quarantine any incomplete building output (retain it for
 * inspection — D-004), remove only the owned scratch, release only the owned
 * pin (if not already released), and mark the operation with the given end
 * phase. Idempotent.
 */
const reconcilePrePublication = async (
	dataDir: string,
	archiveDir: string,
	intent: ArchiveOperationIntent,
	building: string,
	endPhase: ArchiveOperationPhase,
): Promise<void> => {
	// Quarantine incomplete building output if present (retain, don't delete).
	if (existsSync(building)) {
		// Move the building debris into a quarantine subdir named for the
		// operation, retaining it for inspection.
		const quarantineBuilding = join(
			archiveRoot(archiveDir),
			"quarantine",
			`building-${intent.operationId}`,
		)
		await ensurePrivateDirectory(join(archiveRoot(archiveDir), "quarantine"), archiveRoot(archiveDir))
		if (existsSync(quarantineBuilding)) {
			throw new Error(
				`archive operation has both building and quarantine state; refusing to retire authority: ${quarantineBuilding}`,
			)
		}
		await durableRename(building, quarantineBuilding)
		await syncDirectory(buildingRoot(archiveDir))
	} else {
		const quarantineBuilding = join(
			archiveRoot(archiveDir),
			"quarantine",
			`building-${intent.operationId}`,
		)
		if (existsSync(quarantineBuilding)) {
			await assertNoSymlink(archiveDir, quarantineBuilding, "archive building quarantine")
			await assertRealDirectory(quarantineBuilding, "archive building quarantine")
		}
	}
	// Remove owned scratch.
	await removeOwnedScratch(intent.scratchRoot, intent.scratchSubdir)
	// Release the owned pin if it still exists. A pin absence before
	// "pin-released" would be an error, but a pre-publication abort releasing its
	// own pin is the intended recovery — so tolerate already-absent here.
	await releaseOwnedPin(dataDir, intent)
	await advancePhase(archiveDir, intent.operationId, endPhase)
	// Archive the aborted operation journal to completed/ (retained for audit).
	await archiveCompletedOperation(archiveDir, intent.operationId)
}

/**
 * Reconcile a post-promotion operation: the generation + manifest are
 * durably published. Finish pointer/catalog if not done, release the owned pin,
 * remove owned scratch, and archive the operation to "complete". Idempotent.
 */
const reconcilePostPromotion = async (
	dataDir: string,
	archiveDir: string,
	intent: ArchiveOperationIntent,
	operationId: string,
): Promise<void> => {
	// The generation and manifest exist (caller verified). Drive the remaining
	// phases to completion idempotently.
	if (!phaseAtLeast(intent.phase, "pointer-complete")) {
		assertPointerConsistent(archiveDir, intent)
		await selectActiveGeneration(
			archiveDir,
			intent.signal,
			intent.rangeStart,
			intent.generationId,
			intent.baseActiveGenerationId,
		)
		await advancePhase(archiveDir, operationId, "pointer-complete")
	}
	if (!phaseAtLeast(intent.phase, "catalog-complete")) {
		await rebuildCatalog(archiveDir, archiveSignal(intent.signal).name)
		await advancePhase(archiveDir, operationId, "catalog-complete")
	}
	if (!phaseAtLeast(intent.phase, "pin-released")) {
		await releaseOwnedPin(dataDir, intent)
		await advancePhase(archiveDir, operationId, "pin-released")
	}
	if (!phaseAtLeast(intent.phase, "scratch-removed")) {
		await removeOwnedScratch(intent.scratchRoot, intent.scratchSubdir)
		await advancePhase(archiveDir, operationId, "scratch-removed")
	}
	await advancePhase(archiveDir, operationId, "complete")
	await archiveCompletedOperation(archiveDir, operationId)
}

/**
 * Release the journal-owned pin, tolerating its absence ONLY if the recorded
 * phase is already at-or-past "pin-released", or when recovering a
 * pre-publication abort (the operation never published and owns nothing).
 * Otherwise a missing pin is an identity/topology error (fail closed). This
 * implements the plan rule: pin absence is success only where release was
 * already authorized.
 */
const releaseOwnedPin = async (dataDir: string, intent: ArchiveOperationIntent): Promise<void> => {
	const expectedPinPath = join(checkpointPinsRoot(dataDir), intent.checkpointId, `${intent.pinId}.json`)
	if (!existsSync(expectedPinPath)) {
		const absenceAuthorized =
			intent.phase === "intent" ||
			phaseAtLeast(intent.phase, "catalog-complete") ||
			phaseAtLeast(intent.phase, "pin-released")
		if (absenceAuthorized) return
		throw new Error(
			`archive operation pin is missing before release was authorized: ${expectedPinPath} (phase ${intent.phase})`,
		)
	}
	await releaseCheckpointPin(dataDir, intent.checkpointId, expectedPinPath, intent.pinPurpose)
}
