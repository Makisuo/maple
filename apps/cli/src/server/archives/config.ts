// Archive tuning configuration.
//
// Every machine-sensitive archive value is centralized, documented, visible in
// command output, overridable through the CLI or a configuration file, and
// recorded in each generation manifest as the effective runtime values. The
// defaults are the measured research baselines, not universal constants: a
// deployment should calibrate its own values against its checkpoint, archive
// volume, chDB version, and memory budget (see the calibrate command).
//
// `loadTuningConfig` reads a versioned calibration config document (emitted by
// the calibrator's `writeCalibrationConfig`) from a single opened file
// descriptor — the bytes read, the SHA-256 identity, and the regular-file
// check all derive from one `open()` so there is no TOCTOU between read and
// hash and no path the archive-root classifier cannot safely validate.
//
// References: MAPLE-CHECKPOINT-ARCHIVE-PLAN.md "Configuration and Calibration"
// and the research-transfer measured starting values.

import { createHash } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { basename } from "node:path"

/**
 * The effective tuning configuration used by one archive generation. All values
 * are validated at parse time; an unsafe or contradictory combination is
 * rejected before any export runs. `archiveDir` and `scratchRoot` are resolved
 * to absolute paths.
 */
export interface ArchiveTuning {
	/** ClickHouse Parquet writer thread count (`max_threads`). */
	readonly writerThreads: number
	/** Parquet row-group row count (`output_format_parquet_row_group_size`). */
	readonly rowGroupRows: number
	/** Maximum rows in one physical Parquet shard before splitting. */
	readonly maxShardRows: number
	/** Maximum estimated uncompressed bytes in one physical shard before splitting. */
	readonly maxShardBytes: number
	/** Target logical chunk size in bytes (a provisioning hint, not a hard limit). */
	readonly targetChunkBytes: number
	/** Minimum free-space reserve required on the archive volume before writing. */
	readonly minFreeSpaceReserve: number
	/** Resolved absolute archive root directory. */
	readonly archiveDir: string
	/** Resolved absolute scratch root for restored-checkpoint instances. */
	readonly scratchRoot: string
}

export const DEFAULT_ARCHIVE_TUNING = {
	writerThreads: 1,
	rowGroupRows: 10_000,
	maxShardRows: 500_000,
	maxShardBytes: 256 * 1024 * 1024,
	targetChunkBytes: 1024 * 1024 * 1024,
	minFreeSpaceReserve: 512 * 1024 * 1024,
} as const

/**
 * A partial, operator-supplied override. Every field is optional; missing
 * fields fall back to {@link DEFAULT_ARCHIVE_TUNING}. This is the shape accepted
 * from CLI flags and configuration files.
 */
export interface ArchiveTuningOverrides {
	readonly writerThreads?: number
	readonly rowGroupRows?: number
	readonly maxShardRows?: number
	readonly maxShardBytes?: number
	readonly targetChunkBytes?: number
	readonly minFreeSpaceReserve?: number
	readonly archiveDir?: string
	readonly scratchRoot?: string
}

const isPositiveInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0

const requirePositiveInt = (value: unknown, key: string): number => {
	if (!isPositiveInt(value)) throw new Error(`archive tuning ${key} must be a positive integer`)
	return value
}

/**
 * Build an {@link ArchiveTuning} from defaults plus optional overrides, then
 * validate the combination. Rejects:
 *
 * - non-positive or non-integer numeric fields;
 * - a row group larger than the max shard (a shard could never hold one row
 *   group, which would split indefinitely);
 * - a max shard byte estimate smaller than a single row group's worst case;
 * - a free-space reserve larger than the target chunk (nothing could ever be
 *   archived under that reserve on a fresh volume of that size);
 * - a missing archive or scratch root.
 *
 * `archiveDir` and `scratchRoot` must be supplied (defaults are resolved by the
 * CLI layer from the deployment's configured paths); this parser does not
 * invent them.
 */
export const resolveArchiveTuning = (overrides: ArchiveTuningOverrides): ArchiveTuning => {
	const writerThreads = requirePositiveInt(
		overrides.writerThreads ?? DEFAULT_ARCHIVE_TUNING.writerThreads,
		"writerThreads",
	)
	const rowGroupRows = requirePositiveInt(
		overrides.rowGroupRows ?? DEFAULT_ARCHIVE_TUNING.rowGroupRows,
		"rowGroupRows",
	)
	const maxShardRows = requirePositiveInt(
		overrides.maxShardRows ?? DEFAULT_ARCHIVE_TUNING.maxShardRows,
		"maxShardRows",
	)
	const maxShardBytes = requirePositiveInt(
		overrides.maxShardBytes ?? DEFAULT_ARCHIVE_TUNING.maxShardBytes,
		"maxShardBytes",
	)
	const targetChunkBytes = requirePositiveInt(
		overrides.targetChunkBytes ?? DEFAULT_ARCHIVE_TUNING.targetChunkBytes,
		"targetChunkBytes",
	)
	const minFreeSpaceReserve = requirePositiveInt(
		overrides.minFreeSpaceReserve ?? DEFAULT_ARCHIVE_TUNING.minFreeSpaceReserve,
		"minFreeSpaceReserve",
	)
	if (!overrides.archiveDir) throw new Error("archive tuning requires an archive directory")
	if (!overrides.scratchRoot) throw new Error("archive tuning requires a scratch root")
	if (rowGroupRows > maxShardRows) {
		throw new Error("archive tuning rowGroupRows must not exceed maxShardRows")
	}
	// A single row group at the broadest type should fit within a shard's byte
	// budget; otherwise a shard of one row group could already exceed it.
	const minShardBytesForRowGroup = rowGroupRows * 1024
	if (maxShardBytes < minShardBytesForRowGroup) {
		throw new Error(
			`archive tuning maxShardBytes (${maxShardBytes}) is too small for rowGroupRows ` +
				`(${rowGroupRows}); raise maxShardBytes or lower rowGroupRows`,
		)
	}
	if (minFreeSpaceReserve >= targetChunkBytes) {
		throw new Error("archive tuning minFreeSpaceReserve must be smaller than targetChunkBytes")
	}
	if (writerThreads > 32) {
		throw new Error("archive tuning writerThreads must not exceed 32")
	}
	return {
		writerThreads,
		rowGroupRows,
		maxShardRows,
		maxShardBytes,
		targetChunkBytes,
		minFreeSpaceReserve,
		archiveDir: overrides.archiveDir,
		scratchRoot: overrides.scratchRoot,
	}
}

/**
 * The tuning-config identity recorded in a manifest so a generation is
 * reproducible and deployment drift is visible. Includes both the configured
 * defaults and the effective runtime values used to write the generation.
 */
export interface ArchiveTuningRecord {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
	readonly targetChunkBytes: number
	readonly minFreeSpaceReserve: number
}

export const tuningRecord = (tuning: ArchiveTuning): ArchiveTuningRecord => ({
	writerThreads: tuning.writerThreads,
	rowGroupRows: tuning.rowGroupRows,
	maxShardRows: tuning.maxShardRows,
	maxShardBytes: tuning.maxShardBytes,
	targetChunkBytes: tuning.targetChunkBytes,
	minFreeSpaceReserve: tuning.minFreeSpaceReserve,
})

/**
 * The structured identity of a loaded calibration config document, recorded in
 * a generation manifest so the exact config that produced a generation is
 * reproducible. Replaces the prior bare `tuningConfigName: string | null` with
 * a versioned, SHA-256-bound identity. An unknown `formatVersion` fails closed.
 */
export interface TuningConfigIdentity {
	readonly formatVersion: number
	/** A safe logical name derived from the config file's basename (no path). */
	readonly configName: string
	/** SHA-256 of the exact config bytes loaded (64 lowercase hex chars). */
	readonly sha256: string
}

/** The calibration config document format version accepted by the loader. */
export const TUNING_CONFIG_FORMAT_VERSION = 1

const SAFE_CONFIG_NAME = /^[A-Za-z0-9._-]+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const requireConfigCount = (record: Record<string, unknown>, key: string): number => {
	const value = record[key]
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid calibration config field: ${key} (must be a safe non-negative integer)`)
	}
	return value
}

const assertExactKeys = (
	record: Record<string, unknown>,
	keys: ReadonlySet<string>,
	label: string,
	path: string,
): void => {
	for (const key of Object.keys(record)) {
		if (!keys.has(key)) throw new Error(`unknown calibration config ${label}.${key}: ${path}`)
	}
	for (const key of keys) {
		if (!(key in record)) throw new Error(`missing calibration config ${label}.${key}: ${path}`)
	}
}

const CANDIDATE_KEYS = new Set(["writerThreads", "rowGroupRows", "maxShardRows", "maxShardBytes"])
const METRIC_KEYS = new Set([
	"logicalBytes",
	"physicalBytes",
	"compressionRatio",
	"writeThroughputBytesPerSec",
	"peakTempDiskBytes",
	"peakRssBytes",
	"wallMs",
	"rowCount",
])

const validateCandidateRecord = (value: unknown, label: string, path: string): void => {
	if (!isRecord(value)) throw new Error(`invalid calibration config ${label} (record required): ${path}`)
	assertExactKeys(value, CANDIDATE_KEYS, label, path)
	for (const field of CANDIDATE_KEYS) {
		const candidateValue = value[field]
		if (
			typeof candidateValue !== "number" ||
			!Number.isSafeInteger(candidateValue) ||
			candidateValue <= 0
		) {
			throw new Error(
				`invalid calibration config ${label}.${field} (positive safe integer required): ${path}`,
			)
		}
	}
}

const validateMetricsRecord = (value: unknown, label: string, path: string): void => {
	if (!isRecord(value)) throw new Error(`invalid calibration config ${label} (record required): ${path}`)
	assertExactKeys(value, METRIC_KEYS, label, path)
	for (const field of METRIC_KEYS) {
		const metricValue = value[field]
		if (typeof metricValue !== "number" || !Number.isFinite(metricValue) || metricValue < 0) {
			throw new Error(
				`invalid calibration config ${label}.${field} (non-negative finite number required): ${path}`,
			)
		}
	}
	if (!Number.isSafeInteger(value.rowCount)) {
		throw new Error(`invalid calibration config ${label}.rowCount (safe integer required): ${path}`)
	}
}

/**
 * Validate the COMPLETE versioned config schema (S10): every required field must
 * be present and correctly typed, with nested unknown-field rejection. A
 * document containing only `formatVersion` + `effective` is REJECTED — all
 * evidence fields (environment, results, budget, confidence, safetyMargin,
 * recalibrationTriggers, measuredAt, note) are required. This is the strict
 * parser that the prior implementation lacked.
 */
const validateCompleteConfigSchema = (parsed: Record<string, unknown>, path: string): void => {
	const knownTopLevel = new Set([
		"formatVersion",
		"effective",
		"environment",
		"selected",
		"results",
		"budget",
		"confidence",
		"safetyMargin",
		"recalibrationTriggers",
		"measuredAt",
		"note",
	])
	for (const key of Object.keys(parsed)) {
		if (!knownTopLevel.has(key)) {
			throw new Error(`unknown calibration config field '${key}'; refusing: ${path}`)
		}
	}
	// confidence: required enum.
	if (parsed.confidence !== "high" && parsed.confidence !== "low") {
		throw new Error(`invalid calibration config confidence (must be 'high'|'low'): ${path}`)
	}
	// confidence/selected consistency: high ⟺ selected !== null.
	const selectedNull = parsed.selected === null
	if (parsed.confidence === "high" && selectedNull) {
		throw new Error(`invalid calibration config: confidence 'high' requires selected !== null: ${path}`)
	}
	if (parsed.confidence === "low" && !selectedNull) {
		throw new Error(`invalid calibration config: confidence 'low' requires selected === null: ${path}`)
	}
	// safetyMargin: required finite number > 0.
	if (
		typeof parsed.safetyMargin !== "number" ||
		!Number.isFinite(parsed.safetyMargin) ||
		parsed.safetyMargin <= 0
	) {
		throw new Error(`invalid calibration config safetyMargin (must be a positive finite number): ${path}`)
	}
	// measuredAt: the writer emits canonical UTC ISO-8601. Reject arbitrary
	// non-empty strings so evidence ordering and identity remain meaningful.
	if (
		typeof parsed.measuredAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.measuredAt) ||
		!Number.isFinite(Date.parse(parsed.measuredAt))
	) {
		throw new Error(`invalid calibration config measuredAt (canonical ISO-8601 required): ${path}`)
	}
	// note: required string.
	if (typeof parsed.note !== "string") {
		throw new Error(`invalid calibration config note: ${path}`)
	}
	// recalibrationTriggers: required non-empty array of strings.
	if (!Array.isArray(parsed.recalibrationTriggers) || parsed.recalibrationTriggers.length === 0) {
		throw new Error(
			`invalid calibration config recalibrationTriggers (non-empty array required): ${path}`,
		)
	}
	for (const t of parsed.recalibrationTriggers) {
		if (typeof t !== "string" || t.length === 0) {
			throw new Error(`invalid calibration config recalibrationTriggers entry: ${path}`)
		}
	}
	// environment: required record; deep-validate with unknown-field rejection.
	if (!isRecord(parsed.environment)) {
		throw new Error(`invalid calibration config environment (record required): ${path}`)
	}
	const env = parsed.environment
	const knownEnv = new Set([
		"mapleVersion",
		"chdbVersion",
		"schemaFingerprint",
		"executionUser",
		"platform",
		"arch",
		"cpuModel",
		"cpuCount",
		"totalMemoryBytes",
		"measurementTool",
		"archiveVolume",
	])
	for (const key of Object.keys(env)) {
		if (!knownEnv.has(key)) {
			throw new Error(`unknown calibration config environment.${key}: ${path}`)
		}
	}
	for (const f of [
		"mapleVersion",
		"chdbVersion",
		"schemaFingerprint",
		"executionUser",
		"platform",
		"arch",
		"cpuModel",
		"measurementTool",
	]) {
		if (typeof env[f] !== "string") {
			throw new Error(`invalid calibration config environment.${f} (string required): ${path}`)
		}
	}
	for (const f of ["cpuCount", "totalMemoryBytes"]) {
		if (typeof env[f] !== "number" || !Number.isSafeInteger(env[f]) || env[f] < 0) {
			throw new Error(
				`invalid calibration config environment.${f} (non-negative safe integer required): ${path}`,
			)
		}
	}
	// archiveVolume: required record with exactly { fsid, type, archiveDir }.
	if (!isRecord(env.archiveVolume)) {
		throw new Error(`invalid calibration config environment.archiveVolume (record required): ${path}`)
	}
	const vol = env.archiveVolume
	const knownVol = new Set(["fsid", "type", "archiveDir"])
	for (const key of Object.keys(vol)) {
		if (!knownVol.has(key)) {
			throw new Error(`unknown calibration config environment.archiveVolume.${key}: ${path}`)
		}
	}
	if (
		typeof vol.fsid !== "string" ||
		vol.fsid.length === 0 ||
		typeof vol.archiveDir !== "string" ||
		vol.archiveDir.length === 0
	) {
		throw new Error(
			`invalid calibration config environment.archiveVolume (fsid/archiveDir strings required): ${path}`,
		)
	}
	if (typeof vol.type !== "number" || !Number.isSafeInteger(vol.type)) {
		throw new Error(
			`invalid calibration config environment.archiveVolume.type (number required): ${path}`,
		)
	}
	// budget: required record; deep-validate all ceiling fields.
	if (!isRecord(parsed.budget)) {
		throw new Error(`invalid calibration config budget (record required): ${path}`)
	}
	const budget = parsed.budget
	const knownBudget = new Set([
		"memoryBudget",
		"timeBudget",
		"sampleRows",
		"maxCandidateWallMs",
		"minThroughputBytesPerSec",
		"maxTempDiskBytes",
		"freeSpaceReserve",
		"safetyMargin",
	])
	for (const key of Object.keys(budget)) {
		if (!knownBudget.has(key)) {
			throw new Error(`unknown calibration config budget.${key}: ${path}`)
		}
	}
	for (const f of knownBudget) {
		if (typeof budget[f] !== "number" || !Number.isFinite(budget[f]) || budget[f] < 0) {
			throw new Error(
				`invalid calibration config budget.${f} (non-negative finite number required): ${path}`,
			)
		}
	}
	for (const f of [
		"memoryBudget",
		"timeBudget",
		"sampleRows",
		"maxCandidateWallMs",
		"maxTempDiskBytes",
		"freeSpaceReserve",
	]) {
		if (!Number.isSafeInteger(budget[f]) || (f !== "freeSpaceReserve" && budget[f] === 0)) {
			throw new Error(
				`invalid calibration config budget.${f} (safe integer${f === "freeSpaceReserve" ? "" : " > 0"} required): ${path}`,
			)
		}
	}
	const budgetSafetyMargin = budget.safetyMargin
	if (typeof budgetSafetyMargin !== "number" || budgetSafetyMargin <= 0) {
		throw new Error(`invalid calibration config budget.safetyMargin (must be > 0): ${path}`)
	}
	// selected: null OR a record with candidate + worstCase. Deep-validate if present.
	if (parsed.selected !== null) {
		if (!isRecord(parsed.selected)) {
			throw new Error(`invalid calibration config selected (null or record required): ${path}`)
		}
		const sel = parsed.selected
		assertExactKeys(sel, new Set(["candidate", "worstCase"]), "selected", path)
		validateCandidateRecord(sel.candidate, "selected.candidate", path)
		validateMetricsRecord(sel.worstCase, "selected.worstCase", path)
	}
	// results: required array; each entry validated as a CandidateResult-like shape.
	if (!Array.isArray(parsed.results)) {
		throw new Error(`invalid calibration config results (array required): ${path}`)
	}
	for (let i = 0; i < parsed.results.length; i++) {
		const r = parsed.results[i]
		if (!isRecord(r)) {
			throw new Error(`invalid calibration config results[${i}] (record required): ${path}`)
		}
		const knownResult = new Set(["candidate", "signal", "metrics", "ok", "error"])
		for (const key of Object.keys(r)) {
			if (!knownResult.has(key)) {
				throw new Error(`unknown calibration config results[${i}].${key}: ${path}`)
			}
		}
		if (typeof r.signal !== "string" || typeof r.ok !== "boolean") {
			throw new Error(`invalid calibration config results[${i}] (signal/ok required): ${path}`)
		}
		validateCandidateRecord(r.candidate, `results[${i}].candidate`, path)
		if (r.error !== undefined && typeof r.error !== "string") {
			throw new Error(`invalid calibration config results[${i}].error: ${path}`)
		}
		if (r.ok) {
			validateMetricsRecord(r.metrics, `results[${i}].metrics`, path)
		} else if (r.metrics !== null) {
			throw new Error(
				`invalid calibration config results[${i}].metrics (failed result must be null): ${path}`,
			)
		}
	}
}

/**
 * Load and strictly validate a calibration config document from `path`, returning
 * the effective tuning overrides and a SHA-256-bound identity.
 *
 * The file is opened ONCE; the bytes read, the SHA-256, and the regular-file
 * check all derive from that single descriptor (no TOCTOU between read and
 * hash). The descriptor is `fstat`-checked to be a regular file — symlinks,
 * pipes, and devices are refused. This is the safety boundary for an arbitrary
 * operator-supplied path; the archive-root path classifier cannot safely
 * validate config paths outside the archive root.
 *
 * The document schema is validated strictly: required `formatVersion`, an
 * `effective` tuning block whose values are routed through
 * {@link resolveArchiveTuning} (so the same bounds checks as live tuning
 * apply), and unknown top-level fields are rejected. `archiveDir`/`scratchRoot`
 * in the config are NOT applied here; the caller resolves roots and defines
 * precedence (CLI flags override config `effective` values override defaults),
 * rejecting conflicting root overrides explicitly.
 */
export const loadTuningConfig = (
	path: string,
): {
	overrides: ArchiveTuningOverrides
	identity: TuningConfigIdentity
} => {
	// lstat BEFORE open so a symlink at `path` is refused. Then open with
	// O_NOFOLLOW (kernel refuses a symlink at the final component too). Then
	// compare the opened fd's dev/ino against the lstat identity so a swap
	// between lstat and open is detected. The content is read AND hashed from
	// the single opened fd (bounded read), so read+hash are from one descriptor.
	const preStat = lstatSync(path)
	if (!preStat.isFile()) {
		throw new Error(
			`calibration config must be a regular file (refusing symlink, pipe, or device): ${path}`,
		)
	}
	const MAX_CONFIG_BYTES = 16 * 1024 * 1024
	if (preStat.size > MAX_CONFIG_BYTES) {
		throw new Error(
			`calibration config is too large (${preStat.size} bytes > ${MAX_CONFIG_BYTES}); refusing: ${path}`,
		)
	}
	// O_NOFOLLOW refuses a symlink at the final path component at the kernel
	// level, closing the lstat/open race.
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	let bytes: Buffer
	try {
		const fdStat = fstatSync(fd)
		if (!fdStat.isFile()) {
			throw new Error(
				`calibration config must be a regular file (refusing non-regular descriptor): ${path}`,
			)
		}
		// Identity check: the opened fd must be the SAME file lstat saw (same
		// device + inode). A swap between lstat and open is detected here.
		if (fdStat.dev !== preStat.dev || fdStat.ino !== preStat.ino) {
			throw new Error(`calibration config identity changed between lstat and open (TOCTOU): ${path}`)
		}
		// Re-check size on the fd (the lstat size may be stale after a swap).
		if (fdStat.size > MAX_CONFIG_BYTES) {
			throw new Error(
				`calibration config is too large on fd (${fdStat.size} bytes > ${MAX_CONFIG_BYTES}); refusing: ${path}`,
			)
		}
		// Bounded read from the fd: read exactly the fd's size so a huge file
		// cannot exhaust memory and the SHA is over exactly the read bytes.
		const size = fdStat.size
		bytes = Buffer.alloc(size)
		let read = 0
		while (read < size) {
			const n = readSync(fd, bytes, read, size - read, null)
			if (n === 0) break
			read += n
		}
		if (read !== size) {
			throw new Error(`calibration config short read (${read} of ${size} bytes): ${path}`)
		}
	} finally {
		closeSync(fd)
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex")
	const parsed = JSON.parse(bytes.toString("utf8")) as unknown
	if (!isRecord(parsed)) {
		throw new Error(`malformed calibration config (not a record): ${path}`)
	}
	if (parsed.formatVersion !== TUNING_CONFIG_FORMAT_VERSION) {
		throw new Error(
			`unsupported calibration config formatVersion ${String(parsed.formatVersion)} ` +
				`(expected ${TUNING_CONFIG_FORMAT_VERSION}); refusing: ${path}`,
		)
	}
	// Complete strict schema validation (S10): all evidence fields required.
	validateCompleteConfigSchema(parsed, path)
	// effective: required, six numeric knobs, no unknown fields.
	const effectiveRaw = parsed.effective
	if (!isRecord(effectiveRaw)) {
		throw new Error(`calibration config missing 'effective' tuning block: ${path}`)
	}
	const knownEffective = new Set([
		"writerThreads",
		"rowGroupRows",
		"maxShardRows",
		"maxShardBytes",
		"targetChunkBytes",
		"minFreeSpaceReserve",
	])
	for (const key of Object.keys(effectiveRaw)) {
		if (!knownEffective.has(key)) {
			throw new Error(`unknown calibration config effective field '${key}'; refusing: ${path}`)
		}
	}
	const overrides: ArchiveTuningOverrides = {
		writerThreads: requireConfigCount(effectiveRaw, "writerThreads"),
		rowGroupRows: requireConfigCount(effectiveRaw, "rowGroupRows"),
		maxShardRows: requireConfigCount(effectiveRaw, "maxShardRows"),
		maxShardBytes: requireConfigCount(effectiveRaw, "maxShardBytes"),
		targetChunkBytes: requireConfigCount(effectiveRaw, "targetChunkBytes"),
		minFreeSpaceReserve: requireConfigCount(effectiveRaw, "minFreeSpaceReserve"),
	}
	const configName = basename(path)
	if (!SAFE_CONFIG_NAME.test(configName)) {
		throw new Error(
			`unsafe calibration config name (must match ${SAFE_CONFIG_NAME.source}): ${configName}`,
		)
	}
	return {
		overrides,
		identity: { formatVersion: TUNING_CONFIG_FORMAT_VERSION, configName, sha256 },
	}
}
