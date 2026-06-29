import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { CHDB_VERSION, MAPLE_VERSION } from "../../version"
import { SCHEMA_FINGERPRINT } from "../serve"
import {
	acquireCheckpointPin,
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
import { exportSignalShards, type WrittenShard } from "./export"

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
	readonly afterManifestWritten?: () => void | Promise<void>
	readonly afterGenerationPromoted?: () => void | Promise<void>
	readonly afterCatalogAppended?: () => void | Promise<void>
	readonly afterPinReleased?: () => void | Promise<void>
	readonly afterBuildingRemoved?: () => void | Promise<void>
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

const toShardRecord = (shard: WrittenShard): ArchiveShardRecord => ({
	name: shard.name,
	rowCount: shard.rowCount,
	minEventTime: shard.minEventTime,
	maxEventTime: shard.maxEventTime,
	sha256: shard.sha256,
	bytes: shard.bytes,
	columns: shard.columns,
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
 * Steps, each a durable boundary with an optional fault hook:
 * acquire maintenance lock → resolve + pin checkpoint → restore to scratch →
 * create owned building dir → export bounded shards → validate → write manifest
 * → promote active pointer → append catalog → release pin → remove building.
 *
 * On any failure after the pin is acquired, the pin is released only if the
 * failure is provably owned and complete; an uncertain state preserves the pin
 * and the building directory for inspection.
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
	const signal = archiveSignal(signalName)
	// Estimate working bytes: scratch restore (~source size) + Parquet output
	// (~compressed). We don't know the source size yet, so use a conservative
	// estimate of the targetChunkBytes as the working-set proxy.
	const estimatedWorkingBytes = tuning.targetChunkBytes
	await preflightFreeSpace(archiveDir, tuning.archiveDir, tuning.minFreeSpaceReserve, estimatedWorkingBytes)
	const generationId = newArchiveGenerationId()
	const operationId = randomUUID()

	return withMaintenanceLock(dataDir, operationId, async () => {
		const resolved = await resolveCheckpoint(dataDir, checkpointSelector)
		const pinPath = await acquireCheckpointPin(dataDir, resolved.checkpointId, `archive:${generationId}`)
		await faults.afterPinAcquired?.()
		try {
			return await withRestoredCheckpoint(
				resolved,
				{ scratchRoot: tuning.scratchRoot, cleanup: "always" },
				async ({ db, manifest: checkpointManifest }) => {
					await faults.afterScratchRestored?.()
					const dayEndExclusiveIso = nextMidnightUtc(rangeDate)
					const sourceRowCount = countSignalRowsForDay(db, signal, rangeDate)

					const building = buildingGenerationRoot(archiveDir, generationId)
					await ensureOwnedBuilding(archiveDir, building)
					await faults.afterBuildingCreated?.()

					const shardsDir = join(building, "shards")
					await ensurePrivateDirectory(shardsDir, archiveRoot(archiveDir))
					const writtenShards = exportSignalShards(db, signal, rangeDate, shardsDir, {
						writerThreads: tuning.writerThreads,
						rowGroupRows: tuning.rowGroupRows,
						maxShardRows: tuning.maxShardRows,
						maxShardBytes: tuning.maxShardBytes,
					})
					await syncTree(shardsDir)
					await faults.afterShardsWritten?.()

					const archivedRowCount = writtenShards.reduce((sum, s) => sum + s.rowCount, 0)
					if (archivedRowCount !== sourceRowCount) {
						throw new Error(
							`archive row-count mismatch for ${signal.name} ${rangeDate}: source ${sourceRowCount}, ` +
								`archived ${archivedRowCount}`,
						)
					}

					const manifest: ArchiveGenerationManifest = {
						formatVersion: 1,
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

					const superseded = await promoteGeneration(
						archiveDir,
						signal.name,
						rangeDate,
						generationId,
						manifest,
						building,
						faults,
					)
					await appendCatalog(archiveDir, signal.name, manifest, faults)
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
			// The pin protected the checkpoint during export. Release it now that
			// the generation is durable. A release failure does NOT undo the
			// completed archive (a stale pin over-retains data safely), but it IS
			// surfaced to the operator via stderr so a stuck pin is visible and
			// actionable, not silently swallowed.
			try {
				await releaseCheckpointPin(dataDir, resolved.checkpointId, pinPath)
				await faults.afterPinReleased?.()
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				process.stderr.write(
					`warning: failed to release checkpoint pin ${pinPath} (${msg}); ` +
						`the snapshot is over-retained safely but the pin should be inspected and removed manually\n`,
				)
			}
			await removeOwnedBuilding(archiveDir, generationId, faults)
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
	const sql = `SELECT count() FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}'`
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
 * Move the validated building generation into its final location and atomically
 * select it through the active pointer. Returns the previously-active generation
 * id if this generation supersedes one, else null. The old generation directory
 * is retained (never deleted) so late-arrival history is queryable.
 *
 * Exported for filesystem-level testing of supersession and pointer atomicity
 * without requiring a restored chDB.
 */
export const promoteGeneration = async (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	manifestValue: ArchiveGenerationManifest,
	building: string,
	faults: ArchiveGenerationFaults = {},
): Promise<string | null> => {
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
	// Move the entire owned building directory into its final location. The
	// shards travel with it, so there is no separate shards rename and no window
	// in which the final generation exists without its shards.
	await durableRename(building, finalGeneration)
	await syncDirectory(dirname(finalGeneration))
	const manifestPath = generationManifestPath(archiveDir, signal, rangeDate, generationId)
	await assertNoSymlink(archiveDir, manifestPath, "archive manifest")
	await durableJson(manifestPath, manifestValue)
	await syncDirectory(dirname(manifestPath))
	await faults.afterManifestWritten?.()

	// Atomically select this generation. Preserve the previous pointer to report
	// supersession; the old generation directory stays in place.
	const pointerPath = activePointerPath(archiveDir, signal, rangeDate)
	await assertNoSymlink(archiveDir, pointerPath, "archive active pointer")
	let superseded: string | null = null
	if (existsSync(pointerPath)) {
		await assertRealFile(pointerPath, "archive active pointer")
		superseded = readPreviousPointerGenerationId(pointerPath, signal, rangeDate)
	}
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

const removeOwnedBuilding = async (
	archiveDir: string,
	generationId: string,
	faults: ArchiveGenerationFaults,
): Promise<void> => {
	const building = buildingGenerationRoot(archiveDir, generationId)
	if (existsSync(building)) {
		// Only the owned, promoted building dir is removed; anything else is
		// over-retained.
		await rm(building, { recursive: true, force: true })
		await syncDirectory(buildingRoot(archiveDir))
	}
	await faults.afterBuildingRemoved?.()
}
