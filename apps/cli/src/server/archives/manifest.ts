import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ArchiveTuningRecord } from "./config"
import {
	assertNoSymlinkSync,
	assertRealFileSync,
	generationManifestPath,
	validateArchiveId,
	validateRangeDate,
} from "./paths"
import { isArchiveSignalName } from "./signals"

// Versioned, strict archive manifest and pointer formats.
//
// A generation manifest is the authoritative completion record for one sealed
// UTC-day export of one signal. It is written only after every shard is
// validated and is never edited after commit. The active pointer selects
// exactly one generation per (signal, range); selection changes only by atomic
// replacement of `active.json`. Unknown format versions, missing/wrong fields,
// path escape, count mismatch, or checksum mismatch fail closed. Mirrors the
// checkpoint module's `formatVersion` discipline.

const MANIFEST_FORMAT_VERSION = 1
const ACTIVE_POINTER_FORMAT_VERSION = 1

export interface ArchiveShardRecord {
	/** Shard file name, e.g. `00-0000.parquet` (hour + sequence). */
	readonly name: string
	/** Row count READ BACK from the reopened Parquet file (not the source count). */
	readonly rowCount: number
	/** Minimum event time read back from the reopened Parquet (ISO string). */
	readonly minEventTime: string
	/** Maximum event time read back from the reopened Parquet (ISO string). */
	readonly maxEventTime: string
	/** SHA-256 of the shard file bytes. */
	readonly sha256: string
	/** Shard file size in bytes (on-disk, compressed). */
	readonly bytes: number
	/** Column names read back from the reopened Parquet (schema round-trip proof). */
	readonly columns: ReadonlyArray<string>
}

export interface ArchiveGenerationManifest {
	readonly formatVersion: 1
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly rangeEndExclusive: string
	readonly checkpointId: string
	readonly checkpointManifestFingerprint: string
	readonly createdAt: string
	readonly mapleVersion: string
	readonly chdbVersion: string
	readonly schemaFingerprint: string
	readonly sourceRowCount: number
	readonly archivedRowCount: number
	readonly tuning: ArchiveTuningRecord
	readonly tuningConfigName: string | null
	readonly shards: ReadonlyArray<ArchiveShardRecord>
}

export interface ArchiveActivePointer {
	readonly formatVersion: 1
	readonly generationId: string
	readonly signal: string
	readonly rangeStart: string
	readonly selectedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const requiredString = (record: Record<string, unknown>, key: string): string => {
	const value = record[key]
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`invalid archive manifest field: ${key}`)
	return value
}

const requiredCount = (record: Record<string, unknown>, key: string): number => {
	const value = record[key]
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`invalid archive manifest field: ${key}`)
	}
	return value
}

const requiredIso = (record: Record<string, unknown>, key: string): string => {
	const value = requiredString(record, key)
	if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid archive manifest field: ${key}`)
	return value
}

const parseShardRecord = (value: unknown): ArchiveShardRecord => {
	if (!isRecord(value)) throw new Error("invalid archive shard record")
	const name = requiredString(value, "name")
	if (!/^[0-9a-z._-]+\.parquet$/i.test(name)) throw new Error(`invalid archive shard name: ${name}`)
	const columnsRaw = value.columns
	if (!Array.isArray(columnsRaw)) throw new Error("invalid archive shard record field: columns")
	const columns = columnsRaw.map((c) => {
		if (typeof c !== "string") throw new Error("invalid archive shard column name")
		return c
	})
	return {
		name,
		rowCount: requiredCount(value, "rowCount"),
		minEventTime: requiredIso(value, "minEventTime"),
		maxEventTime: requiredIso(value, "maxEventTime"),
		sha256: requiredString(value, "sha256"),
		bytes: requiredCount(value, "bytes"),
		columns,
	}
}

/**
 * Strictly parse an archive generation manifest. Binds the manifest to its
 * expected (signal, range, generation) location and rejects unknown format
 * versions, absent/wrongly typed fields, negative or non-finite counts, signal
 * or range mismatch, and malformed shard records.
 */
export const parseArchiveGenerationManifest = (
	value: unknown,
	expectedSignal?: string,
	expectedRange?: string,
	expectedGenerationId?: string,
): ArchiveGenerationManifest => {
	if (!isRecord(value) || value.formatVersion !== MANIFEST_FORMAT_VERSION) {
		throw new Error("unsupported or malformed archive generation manifest")
	}
	const signal = requiredString(value, "signal")
	if (!isArchiveSignalName(signal)) throw new Error(`unknown archive signal: ${signal}`)
	if (expectedSignal && signal !== expectedSignal) {
		throw new Error(`archive manifest signal mismatch: expected ${expectedSignal}, got ${signal}`)
	}
	const rangeStart = validateRangeDate(requiredString(value, "rangeStart"))
	if (expectedRange && rangeStart !== expectedRange) {
		throw new Error(`archive manifest range mismatch: expected ${expectedRange}, got ${rangeStart}`)
	}
	const generationId = validateArchiveId(requiredString(value, "generationId"), "generation")
	if (expectedGenerationId && generationId !== expectedGenerationId) {
		throw new Error(
			`archive manifest generation mismatch: expected ${expectedGenerationId}, got ${generationId}`,
		)
	}
	const shardsRaw = value.shards
	if (!Array.isArray(shardsRaw)) throw new Error("invalid archive manifest field: shards")
	const shards = shardsRaw.map(parseShardRecord)
	if (!isRecord(value.tuning)) throw new Error("invalid archive manifest field: tuning")
	const tuningRecord = value.tuning as Record<string, unknown>
	return {
		formatVersion: MANIFEST_FORMAT_VERSION,
		generationId,
		signal,
		rangeStart,
		rangeEndExclusive: requiredIso(value, "rangeEndExclusive"),
		checkpointId: validateArchiveId(requiredString(value, "checkpointId"), "checkpoint"),
		checkpointManifestFingerprint: requiredString(value, "checkpointManifestFingerprint"),
		createdAt: requiredIso(value, "createdAt"),
		mapleVersion: requiredString(value, "mapleVersion"),
		chdbVersion: requiredString(value, "chdbVersion"),
		schemaFingerprint: requiredString(value, "schemaFingerprint"),
		sourceRowCount: requiredCount(value, "sourceRowCount"),
		archivedRowCount: requiredCount(value, "archivedRowCount"),
		tuning: {
			writerThreads: requiredCount(tuningRecord, "writerThreads"),
			rowGroupRows: requiredCount(tuningRecord, "rowGroupRows"),
			maxShardRows: requiredCount(tuningRecord, "maxShardRows"),
			maxShardBytes: requiredCount(tuningRecord, "maxShardBytes"),
			targetChunkBytes: requiredCount(tuningRecord, "targetChunkBytes"),
			minFreeSpaceReserve: requiredCount(tuningRecord, "minFreeSpaceReserve"),
		},
		tuningConfigName: typeof value.tuningConfigName === "string" ? value.tuningConfigName : null,
		shards,
	}
}

/**
 * Read and strictly parse a generation manifest from its on-disk path. Binds
 * the manifest to its (signal, range, generation) directory so a manifest
 * copied or moved to the wrong location is rejected.
 */
export const readArchiveGenerationManifest = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
): ArchiveGenerationManifest => {
	const path = generationManifestPath(archiveDir, signal, rangeDate, generationId)
	// Refuse a symlinked descendant on the READ path (the C-1 write fix's mirror):
	// a planted symlink on the signal/range/generation/manifest chain would be
	// followed by readFileSync, reading attacker-controlled content from outside
	// the archive root. This is the single chokepoint for manifest reads.
	assertNoSymlinkSync(archiveDir, path, "archive manifest")
	assertRealFileSync(path, "archive manifest")
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
	return parseArchiveGenerationManifest(parsed, signal, rangeDate, generationId)
}

export const parseArchiveActivePointer = (
	value: unknown,
	expectedSignal?: string,
	expectedRange?: string,
): ArchiveActivePointer => {
	if (!isRecord(value) || value.formatVersion !== ACTIVE_POINTER_FORMAT_VERSION) {
		throw new Error("unsupported or malformed archive active pointer")
	}
	const signal = requiredString(value, "signal")
	const rangeStart = validateRangeDate(requiredString(value, "rangeStart"))
	// Bind the pointer to its on-disk (signal, range) directory so a pointer
	// copied or moved to the wrong range cannot be silently accepted (H-7).
	if (expectedSignal && signal !== expectedSignal) {
		throw new Error(`active pointer signal mismatch: expected ${expectedSignal}, recorded ${signal}`)
	}
	if (expectedRange && rangeStart !== expectedRange) {
		throw new Error(`active pointer range mismatch: expected ${expectedRange}, recorded ${rangeStart}`)
	}
	return {
		formatVersion: ACTIVE_POINTER_FORMAT_VERSION,
		generationId: validateArchiveId(requiredString(value, "generationId"), "generation"),
		signal,
		rangeStart,
		selectedAt: requiredIso(value, "selectedAt"),
	}
}

/** Resolve the shard file path for a record within a generation. */
export const shardFilePath = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	shardName: string,
): string =>
	join(generationManifestPath(archiveDir, signal, rangeDate, generationId), "..", "shards", shardName)
