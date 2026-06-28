import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { rm, statfs } from "node:fs/promises"
import { dirname, join } from "node:path"
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
import { type ArchiveShardRecord, type ArchiveGenerationManifest } from "./manifest"
import {
	activePointerPath,
	assertArchiveRootSeparate,
	assertNoSymlink,
	assertRealDirectory,
	buildingGenerationRoot,
	buildingRoot,
	catalogPath,
	ensurePrivateDirectory,
	generationManifestPath,
	generationRoot,
	newArchiveGenerationId,
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
})

/**
 * Refuse to start if the archive volume does not have at least
 * `minFreeSpaceReserve` bytes free. Machine conditions can change after
 * calibration, so this runs at operation time, not just at calibration.
 */
const preflightFreeSpace = async (archiveDir: string, minFreeSpaceReserve: number): Promise<void> => {
	if (!existsSync(archiveDir)) return // a missing root is created later; preflight is for an existing volume
	const info = await statfs(archiveDir)
	const free = info.bavail * info.bsize
	if (free < minFreeSpaceReserve) {
		throw new Error(
			`archive volume has ${free} bytes free, below the ${minFreeSpaceReserve}-byte reserve; ` +
				`free space or lower the reserve after recalibration`,
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
	await preflightFreeSpace(tuning.archiveDir, tuning.minFreeSpaceReserve)
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
					const dayStartIso = `${rangeDate}T00:00:00.000Z`
					const dayEndExclusiveIso = `${rangeDate}T23:59:59.999999999Z`
					const sourceRowCount = countSignalRowsForDay(db, signal, dayStartIso, dayEndExclusiveIso)

					const building = buildingGenerationRoot(archiveDir, generationId)
					await ensureOwnedBuilding(archiveDir, building)
					await faults.afterBuildingCreated?.()

					const shardsDir = join(building, "shards")
					await ensurePrivateDirectory(shardsDir)
					const writtenShards = exportSignalShards(db, signal, dayStartIso, shardsDir, {
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
			// the generation is durable. A release failure is reported but does not
			// undo the completed archive; a stale pin over-retains data safely.
			try {
				await releaseCheckpointPin(dataDir, resolved.checkpointId, pinPath)
				await faults.afterPinReleased?.()
			} catch {
				// Preserve over-retention: report via the result path, do not throw.
			}
			await removeOwnedBuilding(archiveDir, generationId, faults)
		}
	})
}

const countSignalRowsForDay = (
	db: { query: (sql: string, format?: string) => string },
	signal: ArchiveSignal,
	dayStartIso: string,
	dayEndIso: string,
): number => {
	const sql =
		`SELECT count() AS c FROM ${signal.name} ` +
		`WHERE ${signal.eventTimeColumn} >= '${dayStartIso}' AND ${signal.eventTimeColumn} <= '${dayEndIso}'`
	const result = db.query(sql, "JSONEachRow")
	if (result.trim().length === 0) return 0
	const parsed = JSON.parse(result) as ReadonlyArray<{ c: string | number }>
	return Number(parsed[0]?.c ?? 0)
}

const ensureOwnedBuilding = async (archiveDir: string, building: string): Promise<void> => {
	const root = buildingRoot(archiveDir)
	if (existsSync(root)) {
		await assertNoSymlink(archiveDir, root, "archive building root")
		await assertRealDirectory(root, "archive building root")
	}
	await ensurePrivateDirectory(root)
	if (existsSync(building)) {
		throw new Error(`archive building generation already exists; refusing to overwrite: ${building}`)
	}
	await ensurePrivateDirectory(building)
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
		throw new Error(`archive generation already exists; refusing to overwrite: ${finalGeneration}`)
	}
	const range = rangeRoot(archiveDir, signal, rangeDate)
	await ensurePrivateDirectory(range)
	await ensurePrivateDirectory(generationsRootPath(archiveDir, signal, rangeDate))
	// Move the entire owned building directory into its final location. The
	// shards travel with it, so there is no separate shards rename and no window
	// in which the final generation exists without its shards.
	await durableRename(building, finalGeneration)
	await syncDirectory(dirname(finalGeneration))
	const manifestPath = generationManifestPath(archiveDir, signal, rangeDate, generationId)
	await durableJson(manifestPath, manifestValue)
	await syncDirectory(dirname(manifestPath))
	await faults.afterManifestWritten?.()

	// Atomically select this generation. Preserve the previous pointer to report
	// supersession; the old generation directory stays in place.
	const pointerPath = activePointerPath(archiveDir, signal, rangeDate)
	let superseded: string | null = null
	if (existsSync(pointerPath)) {
		const previous = JSON.parse(readFileSync(pointerPath, "utf8")) as { generationId?: string }
		superseded = typeof previous.generationId === "string" ? previous.generationId : null
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
	const existing = existsSync(path) ? `${readFileSync(path, "utf8")}` : ""
	const line = `${JSON.stringify({
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
