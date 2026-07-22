import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
	type ArchiveTuningRecord,
	type TuningConfigIdentity,
	LEGACY_TUNING_CONFIG_FORMAT_VERSION,
	TUNING_CONFIG_FORMAT_VERSION,
} from "./config"
import { KNOWN_COMPLEX_DIGEST_ALGORITHMS } from "./export"
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
//       explicit algorithm field; bare `tuningConfigName` string.
//   3 — config/calibration gate. `tuningConfigName` replaced by structured,
//       SHA-256-bound `tuningConfig` identity ({ formatVersion, configName,
//       sha256 } | null). A v2 manifest lacks this structured field; a v3
//       reader rejects v2 (and v1) fail-closed, preserving files, because the
//       config-identity semantics changed and a silent null would lose identity.
//       (Older archives are not migrated in place; re-export to re-validate.)
const MANIFEST_FORMAT_VERSION = 3
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
	/** The digest algorithm that produced {@link complexDigest} (e.g. cityhash64-multiset-v3). */
	readonly complexDigestAlgorithm: string
}

export interface ArchiveGenerationManifest {
	readonly formatVersion: 3
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
	/**
	 * Structured identity of the calibration config that produced the effective
	 * tuning, or `null` when defaults/CLI overrides were used. Versioned and
	 * SHA-256-bound so a generation's exact config is reproducible. Replaces the
	 * prior bare `tuningConfigName` string.
	 */
	readonly tuningConfig: TuningConfigIdentity | null
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

const MANIFEST_KEYS = new Set([
	"formatVersion",
	"generationId",
	"signal",
	"rangeStart",
	"rangeEndExclusive",
	"checkpointId",
	"checkpointManifestFingerprint",
	"createdAt",
	"mapleVersion",
	"chdbVersion",
	"schemaFingerprint",
	"sourceRowCount",
	"archivedRowCount",
	"tuning",
	"tuningConfig",
	"shards",
])

const TUNING_KEYS = new Set([
	"writerThreads",
	"rowGroupRows",
	"maxShardRows",
	"maxShardBytes",
	"targetChunkBytes",
	"minFreeSpaceReserve",
])

const assertExactOwnKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>, label = ""): void => {
	const location = label.length > 0 ? `${label} ` : ""
	for (const key of keys) {
		if (!Object.prototype.hasOwnProperty.call(record, key)) {
			throw new Error(`invalid archive manifest ${location}field: ${key} (required in formatVersion 3)`)
		}
	}
	for (const key of Object.keys(record)) {
		if (!keys.has(key)) throw new Error(`unknown archive manifest ${location}field: ${key}`)
	}
}

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

const requiredPositiveInteger = (record: Record<string, unknown>, key: string): number => {
	const value = record[key]
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`invalid archive manifest tuning field: ${key} (must be a positive integer)`)
	}
	return value
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** A safe logical config name (no path separators, no traversal). */
const SAFE_CONFIG_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Strictly parse the structured `tuningConfig` identity field of a manifest.
 * Accepts `null` (no config was loaded) or a record with exactly
 * `{ formatVersion, configName, sha256 }`. Rejects unknown subfields, a bad
 * SHA-256, an unsafe config name, or a config formatVersion outside the two
 * explicitly known identities. Manifest v3 stores an opaque, hash-bound config
 * identity and can therefore safely describe legacy v1, symmetric v2, and
 * directional v3 documents; only the config loader refuses v1 for new writes.
 */
const parseTuningConfig = (value: unknown): TuningConfigIdentity | null => {
	if (value === null) return null
	if (!isRecord(value)) {
		throw new Error("invalid archive manifest field: tuningConfig (must be null or a record)")
	}
	const knownKeys = new Set(["formatVersion", "configName", "sha256"])
	for (const key of Object.keys(value)) {
		if (!knownKeys.has(key)) {
			throw new Error(`unknown archive manifest tuningConfig field: ${key}`)
		}
	}
	const formatVersion = value.formatVersion
	if (
		typeof formatVersion !== "number" ||
		!Number.isSafeInteger(formatVersion) ||
		(formatVersion !== 1 &&
			formatVersion !== LEGACY_TUNING_CONFIG_FORMAT_VERSION &&
			formatVersion !== TUNING_CONFIG_FORMAT_VERSION)
	) {
		throw new Error(
			`invalid archive manifest tuningConfig.formatVersion (known versions: 1, ${LEGACY_TUNING_CONFIG_FORMAT_VERSION}, ${TUNING_CONFIG_FORMAT_VERSION}): ${String(formatVersion)}`,
		)
	}
	const configName = requiredString(value, "configName")
	if (!SAFE_CONFIG_NAME.test(configName)) {
		throw new Error(`invalid archive manifest tuningConfig.configName (unsafe name): ${configName}`)
	}
	const sha256 = requiredString(value, "sha256")
	if (!SHA256_HEX.test(sha256)) {
		throw new Error(`invalid archive manifest tuningConfig.sha256 (must be 64 hex chars): ${sha256}`)
	}
	return { formatVersion, configName, sha256 }
}

/**
 * Parse the path-independent portion of resolveArchiveTuning's effective
 * values. A manifest records no roots, but must preserve the same numeric and
 * cross-field invariants that governed its writer.
 */
const parseTuningRecord = (value: unknown): ArchiveTuningRecord => {
	if (!isRecord(value)) throw new Error("invalid archive manifest field: tuning")
	assertExactOwnKeys(value, TUNING_KEYS, "tuning")
	const tuning = {
		writerThreads: requiredPositiveInteger(value, "writerThreads"),
		rowGroupRows: requiredPositiveInteger(value, "rowGroupRows"),
		maxShardRows: requiredPositiveInteger(value, "maxShardRows"),
		maxShardBytes: requiredPositiveInteger(value, "maxShardBytes"),
		targetChunkBytes: requiredPositiveInteger(value, "targetChunkBytes"),
		minFreeSpaceReserve: requiredPositiveInteger(value, "minFreeSpaceReserve"),
	}
	if (tuning.rowGroupRows > tuning.maxShardRows) {
		throw new Error("archive tuning rowGroupRows must not exceed maxShardRows")
	}
	const minShardBytesForRowGroup = tuning.rowGroupRows * 1024
	if (tuning.maxShardBytes < minShardBytesForRowGroup) {
		throw new Error(
			`archive tuning maxShardBytes (${tuning.maxShardBytes}) is too small for rowGroupRows ` +
				`(${tuning.rowGroupRows}); raise maxShardBytes or lower rowGroupRows`,
		)
	}
	if (tuning.minFreeSpaceReserve >= tuning.targetChunkBytes) {
		throw new Error("archive tuning minFreeSpaceReserve must be smaller than targetChunkBytes")
	}
	if (tuning.writerThreads > 32) {
		throw new Error("archive tuning writerThreads must not exceed 32")
	}
	return tuning
}

/**
 * A required ISO-8601 string for MANIFEST-LEVEL timestamps (createdAt,
 * selectedAt) and the canonical `rangeEndExclusive` (always a `...Z` ISO from
 * nextMidnightUtc). These are NOT shard event-time evidence — that uses epoch
 * nanoseconds (see requiredNanoDecimal) to be host-timezone-independent.
 */
const requiredIso = (record: Record<string, unknown>, key: string): string => {
	const value = requiredString(record, key)
	const parsed = Date.parse(value)
	// GC orders generations by these strings, so merely accepting anything
	// Date.parse understands is unsafe: offsets and non-padded forms do not sort
	// chronologically. Writers emit canonical UTC ISO strings; readers require
	// the exact same representation.
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new Error(`invalid archive manifest field: ${key} (must be canonical UTC ISO-8601)`)
	}
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
	if (!KNOWN_COMPLEX_DIGEST_ALGORITHMS.has(complexDigestAlgorithm)) {
		throw new Error(
			`invalid archive shard complexDigestAlgorithm: ${complexDigestAlgorithm} ` +
				`(known: ${[...KNOWN_COMPLEX_DIGEST_ALGORITHMS].join(", ")}); the manifest is preserved as-is`,
		)
	}
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
	// inspection. v3 introduced the structured, SHA-256-bound `tuningConfig`
	// identity; a v2 manifest (bare `tuningConfigName`) is incompatible with this
	// reader because the config-identity semantics changed — silently treating
	// the missing field as null would lose the config identity. Surface it
	// distinctly so the operator re-exports.
	if (value.formatVersion !== MANIFEST_FORMAT_VERSION) {
		throw new Error(
			`unsupported archive manifest formatVersion ${String(value.formatVersion)} (expected ${MANIFEST_FORMAT_VERSION}); ` +
				`the manifest is preserved as-is. v3 introduced the structured tuningConfig identity (v2 used a bare name and v1 used timezone-dependent time evidence); re-export the range to re-validate.`,
		)
	}
	assertExactOwnKeys(value, MANIFEST_KEYS)
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
		tuning: parseTuningRecord(value.tuning),
		// v3 requires its own explicit tuningConfig key. The value is either null
		// or the strict, SHA-256-bound identity parsed above.
		tuningConfig: parseTuningConfig(value.tuningConfig),
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
