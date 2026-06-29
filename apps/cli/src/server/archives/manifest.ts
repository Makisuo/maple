import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ArchiveTuningRecord } from "./config"
import {
	assertNoSymlinkSync,
	assertRealFileSync,
	generationManifestPath,
	nextMidnightUtc,
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

// Manifest format version history:
//   1 — round 4. Shard time evidence as timezone-less ISO strings parsed with
//       Date.parse (host-timezone-dependent); commutative per-column-sum digest.
//   2 — round 5. Shard time evidence as UTC epoch-nanosecond DECIMAL STRINGS
//       (parsed with BigInt, host-timezone-independent); multiset digest with an
//       explicit algorithm field. An unknown or older (1) format fails closed
//       while preserving its files, so an incompatible state is surfaced, not
//       silently re-interpreted. (Older archives written by v1 are not migrated
//       in place; they must be re-exported if they are to be re-validated.)
const MANIFEST_FORMAT_VERSION = 2
const ACTIVE_POINTER_FORMAT_VERSION = 1

export interface ArchiveShardRecord {
	/** Shard file name, e.g. `00-0000.parquet` (hour + sequence). */
	readonly name: string
	/** Row count READ BACK from the reopened Parquet file (not the source count). */
	readonly rowCount: number
	/** Min event time, UTC epoch nanoseconds as a decimal string (host-tz-independent). */
	readonly minEventTimeUnixNano: string
	/** Max event time, UTC epoch nanoseconds as a decimal string (host-tz-independent). */
	readonly maxEventTimeUnixNano: string
	/** SHA-256 of the shard file bytes. */
	readonly sha256: string
	/** Shard file size in bytes (on-disk, compressed). */
	readonly bytes: number
	/** Column names read back from the reopened Parquet (schema round-trip proof). */
	readonly columns: ReadonlyArray<string>
	/**
	 * Complex-value digest over the reopened shard (algorithm named by
	 * complexDigestAlgorithm). Detects same-typed column swaps, cross-row value
	 * reassociation, and dup/drop that preserve count and time extrema.
	 */
	readonly complexDigest: string
	/** The digest algorithm that produced {@link complexDigest} (e.g. cityhash64-multiset-v1). */
	readonly complexDigestAlgorithm: string
}

export interface ArchiveGenerationManifest {
	readonly formatVersion: 2
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
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid archive manifest field: ${key} (must be a safe non-negative integer)`)
	}
	return value
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * A required ISO-8601 string for MANIFEST-LEVEL timestamps (createdAt,
 * selectedAt) and the canonical `rangeEndExclusive` (always a `...Z` ISO from
 * nextMidnightUtc). These are NOT shard event-time evidence — that uses epoch
 * nanoseconds (see requiredNanoDecimal) to be host-timezone-independent.
 */
const requiredIso = (record: Record<string, unknown>, key: string): string => {
	const value = requiredString(record, key)
	if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid archive manifest field: ${key}`)
	return value
}

/** A non-negative decimal integer string (epoch nanoseconds), parsed as BigInt. */
const NANO_DECIMAL = /^[0-9]+$/
const requiredNanoDecimal = (record: Record<string, unknown>, key: string): bigint => {
	const value = requiredString(record, key)
	if (!NANO_DECIMAL.test(value)) {
		throw new Error(
			`invalid archive manifest field: ${key} (must be a non-negative decimal integer string)`,
		)
	}
	return BigInt(value)
}

const parseShardRecord = (
	value: unknown,
	rangeStart: string,
	rangeEndExclusive: string,
): ArchiveShardRecord => {
	if (!isRecord(value)) throw new Error("invalid archive shard record")
	const name = requiredString(value, "name")
	if (!/^[0-9a-z._-]+\.parquet$/i.test(name)) throw new Error(`invalid archive shard name: ${name}`)
	const columnsRaw = value.columns
	if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
		throw new Error("invalid archive shard record field: columns (must be a nonempty array)")
	}
	const columns = columnsRaw.map((c) => {
		if (typeof c !== "string" || c.length === 0) throw new Error("invalid archive shard column name")
		return c
	})
	const sha256 = requiredString(value, "sha256")
	if (!SHA256_HEX.test(sha256))
		throw new Error(`invalid archive shard sha256 (must be 64 hex chars): ${sha256}`)
	const rowCount = requiredCount(value, "rowCount")
	const minNano = requiredNanoDecimal(value, "minEventTimeUnixNano")
	const maxNano = requiredNanoDecimal(value, "maxEventTimeUnixNano")
	if (minNano > maxNano) {
		throw new Error(`archive shard ${name}: minEventTimeUnixNano > maxEventTimeUnixNano`)
	}
	// Bind shard time evidence to the sealed range in EPOCH NANOSECONDS
	// (host-timezone-independent). The range bounds are computed from the UTC
	// rangeDate and its next-midnight ISO as nanos; a shard whose min/max falls
	// outside [rangeStart 00:00:00 UTC, next midnight UTC) is rejected. A valid
	// 23:30 UTC late-day shard is accepted under ANY host timezone.
	const rangeStartNano = BigInt(Date.parse(`${rangeStart}T00:00:00.000Z`)) * 1_000_000n
	const rangeEndNano = BigInt(Date.parse(rangeEndExclusive)) * 1_000_000n
	if (minNano < rangeStartNano || maxNano >= rangeEndNano) {
		throw new Error(
			`archive shard ${name}: event time [${minNano}, ${maxNano}] ns outside sealed range ` +
				`[${rangeStartNano}, ${rangeEndNano}) ns`,
		)
	}
	const bytes = requiredCount(value, "bytes")
	const complexDigest = requiredString(value, "complexDigest")
	if (!/^[0-9]+$/.test(complexDigest)) {
		throw new Error(`invalid archive shard complexDigest (must be a numeric digest): ${complexDigest}`)
	}
	const complexDigestAlgorithm = requiredString(value, "complexDigestAlgorithm")
	return {
		name,
		rowCount,
		minEventTimeUnixNano: minNano.toString(),
		maxEventTimeUnixNano: maxNano.toString(),
		sha256,
		bytes,
		columns,
		complexDigest,
		complexDigestAlgorithm,
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
	if (!isRecord(value)) {
		throw new Error("malformed archive generation manifest (not a record)")
	}
	// Fail closed on an unknown OR older format version, preserving the files for
	// inspection. A v1 manifest (round 4: timezone-dependent time evidence,
	// commutative digest) is incompatible with the round-5 reader and must not be
	// silently re-interpreted; surface it distinctly so the operator re-exports.
	if (value.formatVersion !== MANIFEST_FORMAT_VERSION) {
		throw new Error(
			`unsupported archive manifest formatVersion ${String(value.formatVersion)} (expected ${MANIFEST_FORMAT_VERSION}); ` +
				`the manifest is preserved as-is. A v1 manifest is incompatible with this reader (round 5 changed time evidence and the digest); re-export the range to re-validate.`,
		)
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
	// Parse and validate rangeEndExclusive BEFORE the shards so each shard record
	// can be bound to the sealed range (blocker #6).
	const rangeEndExclusive = requiredIso(value, "rangeEndExclusive")
	// rangeEndExclusive must be the next midnight after rangeStart (exclusive end).
	const expectedEnd = nextMidnightUtc(rangeStart)
	if (rangeEndExclusive !== expectedEnd) {
		throw new Error(
			`archive manifest rangeEndExclusive must be next-midnight ${expectedEnd}, got ${rangeEndExclusive}`,
		)
	}
	const shardsRaw = value.shards
	if (!Array.isArray(shardsRaw)) throw new Error("invalid archive manifest field: shards")
	const shards = shardsRaw.map((s) => parseShardRecord(s, rangeStart, rangeEndExclusive))
	// Cross-field validation (H-7): unique shard names, shard-row sum equals
	// archivedRowCount, source count equals archived count.
	const shardNames = new Set<string>()
	let shardRowSum = 0
	for (const shard of shards) {
		if (shardNames.has(shard.name)) {
			throw new Error(`archive manifest has duplicate shard name: ${shard.name}`)
		}
		shardNames.add(shard.name)
		shardRowSum += shard.rowCount
	}
	const sourceRowCount = requiredCount(value, "sourceRowCount")
	const archivedRowCount = requiredCount(value, "archivedRowCount")
	if (shardRowSum !== archivedRowCount) {
		throw new Error(
			`archive manifest shard row sum (${shardRowSum}) != archivedRowCount (${archivedRowCount})`,
		)
	}
	if (sourceRowCount !== archivedRowCount) {
		throw new Error(
			`archive manifest sourceRowCount (${sourceRowCount}) != archivedRowCount (${archivedRowCount})`,
		)
	}
	if (!isRecord(value.tuning)) throw new Error("invalid archive manifest field: tuning")
	const tuningRecord = value.tuning as Record<string, unknown>
	return {
		formatVersion: MANIFEST_FORMAT_VERSION,
		generationId,
		signal,
		rangeStart,
		rangeEndExclusive,
		checkpointId: validateArchiveId(requiredString(value, "checkpointId"), "checkpoint"),
		checkpointManifestFingerprint: requiredString(value, "checkpointManifestFingerprint"),
		createdAt: requiredIso(value, "createdAt"),
		mapleVersion: requiredString(value, "mapleVersion"),
		chdbVersion: requiredString(value, "chdbVersion"),
		schemaFingerprint: requiredString(value, "schemaFingerprint"),
		sourceRowCount,
		archivedRowCount,
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
