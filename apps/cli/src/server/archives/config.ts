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

/**
 * The prior v2 document encoded two-sided held-out resource deltas. Keep it
 * readable because calibration configs are immutable operator artifacts.
 */
export const LEGACY_TUNING_CONFIG_FORMAT_VERSION = 2

/**
 * New calibration configs encode directional held-out resource costs: lower
 * observed cost is safe, while only a regression beyond tolerance fails.
 */
export const TUNING_CONFIG_FORMAT_VERSION = 3

export type SupportedTuningConfigFormatVersion =
	| typeof LEGACY_TUNING_CONFIG_FORMAT_VERSION
	| typeof TUNING_CONFIG_FORMAT_VERSION

/** Canonical held-out tolerances shared by calibration config formats 2 and 3. */
export const CALIBRATION_HELD_OUT_TOLERANCES = {
	peakRssBytes: 0.5,
	wallMs: 0.5,
	writeThroughputBytesPerSec: 0.75,
	compressionRatio: 0.5,
	physicalBytes: 0.5,
	peakTempDiskBytes: 0.5,
} as const

/** Exact operator-visible events that require recalibration. */
export const CALIBRATION_RECALIBRATION_TRIGGERS = [
	"Maple version change",
	"chDB version change",
	"Schema fingerprint change",
	"Hardware change (CPU count, memory, storage speed)",
	"Archive-volume replacement or filesystem change",
	"Material telemetry-shape change (row width, cardinality, signal mix)",
] as const

/**
 * The held-out window is strictly LARGER than training and disjoint from it:
 * training covers ordered rows `[0, sampleRows)`; held-out covers
 * `[sampleRows, sampleRows + heldOutSampleRows(sampleRows))`. Defined here
 * (the low-level config module) so the loader and the calibrator share one
 * source of truth without a circular import.
 */
export const HELD_OUT_SAMPLE_MULTIPLIER = 2

export const heldOutSampleRows = (sampleRows: number): number => {
	if (!Number.isSafeInteger(sampleRows) || sampleRows <= 0) {
		throw new Error(`calibration sampleRows must be a positive safe integer: ${sampleRows}`)
	}
	const held = HELD_OUT_SAMPLE_MULTIPLIER * sampleRows
	if (!Number.isSafeInteger(held) || held <= sampleRows) {
		throw new Error(`calibration held-out sample derivation overflow: ${sampleRows}`)
	}
	return held
}

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

export interface VerifiedCalibrationConfigDocument {
	readonly formatVersion: SupportedTuningConfigFormatVersion
	readonly measuredAt: string
	readonly confidence: "high"
	readonly checkpoint: {
		readonly checkpointId: string
		readonly manifestFingerprint: string
	}
	readonly candidateMatrix: ReadonlyArray<Record<string, number>>
	readonly requiredSignals: ReadonlyArray<string>
	readonly budget: Record<string, number>
	readonly selected: {
		readonly candidate: Record<string, number>
		readonly worstCase: Record<string, number>
	}
	readonly heldOut: {
		readonly results: ReadonlyArray<Record<string, unknown>>
		readonly worstCase: Record<string, number>
		readonly signalComparisons: ReadonlyArray<Record<string, unknown>>
		readonly passed: true
		readonly tolerances: Record<string, number>
	}
	readonly heldOutAttempts: ReadonlyArray<{
		readonly candidate: Record<string, number>
		readonly results: ReadonlyArray<Record<string, unknown>>
		readonly worstCase: Record<string, number> | null
		readonly signalComparisons: ReadonlyArray<Record<string, unknown>>
		readonly passed: boolean
	}>
	readonly environment: {
		readonly mapleVersion: string
		readonly chdbVersion: string
		readonly schemaFingerprint: string
		readonly executionUser: string
		readonly platform: string
		readonly arch: string
		readonly cpuModel: string
		readonly cpuCount: number
		readonly totalMemoryBytes: number
		readonly measurementTool: string
		readonly archiveVolume: {
			readonly fsid: string
			readonly type: number
			readonly archiveDir: string
		}
	}
	readonly effective: ArchiveTuningRecord
	readonly samplePolicy: {
		readonly trainingRows: number
		readonly heldOutMultiplier: number
		readonly heldOutRows: number
		readonly trainingWindow: string
		readonly heldOutWindow: string
	}
	readonly derivation: {
		readonly minFreeSpaceReserve: "budget.freeSpaceReserve"
		readonly targetChunkBytes: "max(4 * selected.candidate.maxShardBytes, budget.freeSpaceReserve + selected.candidate.maxShardBytes)"
	}
	readonly safetyMargin: number
	readonly recalibrationTriggers: ReadonlyArray<string>
	readonly results: ReadonlyArray<Record<string, unknown>>
	readonly note: string
}

export interface LoadedTuningConfig {
	readonly overrides: ArchiveTuningOverrides
	readonly identity: TuningConfigIdentity
	readonly document: VerifiedCalibrationConfigDocument
}

const EXPECTED_SIGNALS = [
	"logs",
	"traces",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
] as const

const EXPECTED_CANDIDATES = [
	{ writerThreads: 1, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 5_000, maxShardRows: 250_000, maxShardBytes: 128 * 1024 * 1024 },
	{ writerThreads: 2, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 20_000, maxShardRows: 1_000_000, maxShardBytes: 512 * 1024 * 1024 },
] as const

const exactJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const resultMetrics = (value: unknown, label: string, path: string): Record<string, number> => {
	validateMeasuredMetricsRecord(value, label, path)
	return value as Record<string, number>
}

const worstCaseFromResults = (
	results: ReadonlyArray<Record<string, unknown>>,
	path: string,
): Record<string, number> => {
	if (results.length === 0) throw new Error(`calibration config has no results to aggregate: ${path}`)
	const metrics = results.map((result, i) => resultMetrics(result.metrics, `aggregate[${i}].metrics`, path))
	const max = (key: string): number => Math.max(...metrics.map((entry) => entry[key]!))
	const min = (key: string): number => Math.min(...metrics.map((entry) => entry[key]!))
	return {
		logicalBytes: max("logicalBytes"),
		physicalBytes: max("physicalBytes"),
		compressionRatio: max("compressionRatio"),
		writeThroughputBytesPerSec: min("writeThroughputBytesPerSec"),
		peakTempDiskBytes: max("peakTempDiskBytes"),
		peakRssBytes: max("peakRssBytes"),
		wallMs: max("wallMs"),
		rowCount: max("rowCount"),
	}
}

const metricsMeetBudget = (metrics: Record<string, number>, budget: Record<string, number>): boolean => {
	const margin = budget.safetyMargin!
	return (
		metrics.peakRssBytes! * margin <= budget.memoryBudget! &&
		metrics.wallMs! <= budget.maxCandidateWallMs! &&
		(budget.minThroughputBytesPerSec === 0 ||
			metrics.writeThroughputBytesPerSec! / margin >= budget.minThroughputBytesPerSec!) &&
		metrics.peakTempDiskBytes! * margin <= budget.maxTempDiskBytes!
	)
}

type HeldOutComparisonPolicy = "symmetric" | "directional"

const expectedComparisons = (
	predicted: Record<string, number>,
	observed: Record<string, number>,
	tolerances: Record<string, number>,
	policy: HeldOutComparisonPolicy,
	sizeScaling?: { ratio: number; metrics: ReadonlySet<"wallMs" | "physicalBytes"> },
): ReadonlyArray<Record<string, unknown>> => {
	const ratio = sizeScaling?.ratio ?? 1
	const scale = (metric: "wallMs" | "physicalBytes", value: number): number =>
		sizeScaling && sizeScaling.metrics.has(metric) && Number.isFinite(ratio) ? value * ratio : value
	const metrics = [
		"peakRssBytes",
		"wallMs",
		"writeThroughputBytesPerSec",
		"compressionRatio",
		"physicalBytes",
		"peakTempDiskBytes",
	] as const
	return metrics.map((metric) => {
		// wallMs/physicalBytes use the size-scaled prediction (held-out is larger);
		// throughput/compression are size-invariant; peaks are absolute.
		const rawP = predicted[metric]!
		const p =
			metric === "wallMs"
				? scale("wallMs", rawP)
				: metric === "physicalBytes"
					? scale("physicalBytes", rawP)
					: rawP
		const o = observed[metric]!
		const tolerance = tolerances[metric]!
		const throughput = metric === "writeThroughputBytesPerSec"
		const relativeDelta = throughput
			? p > 0
				? Math.max(0, (p - o) / p)
				: 0
			: p > 0
				? policy === "directional"
					? // Lower resource use is safe. This mirrors comparePredictedObserved
						// exactly for v3 (and transitional directional v2) documents.
						Math.max(0, (o - p) / p)
					: Math.abs(o - p) / p
				: o === 0
					? 0
					: null
		const withinTolerance = throughput
			? o >= p * (1 - tolerance)
			: relativeDelta !== null && relativeDelta <= tolerance
		return { metric, predicted: p, observed: o, tolerance, withinTolerance, relativeDelta }
	})
}

/**
 * Recompute the per-signal held-out comparison entries from the recorded
 * training and held-out results, mirroring the production
 * `compareHeldOutPerSignal`. For each signal (canonical order), pair the
 * same-candidate training result with the held-out result, scale wallMs/
 * physicalBytes by THAT signal's heldOut/training logical-byte ratio, compare
 * throughput/compression directly and RSS/temp-disk absolutely, and require all
 * six metrics within tolerance for that signal. Returns null (incomplete) when a
 * signal is unpaired or either logicalBytes is not strictly positive. Pure.
 */
const expectedSignalComparisons = (
	trainingResults: ReadonlyArray<Record<string, unknown>>,
	heldOutResults: ReadonlyArray<Record<string, unknown>>,
	candidate: Record<string, number>,
	tolerances: Record<string, number>,
	policy: HeldOutComparisonPolicy,
): ReadonlyArray<Record<string, unknown>> | null => {
	const findPaired = (
		results: ReadonlyArray<Record<string, unknown>>,
		signal: string,
	): Record<string, unknown> | undefined =>
		results.find(
			(r) =>
				r.signal === signal &&
				r.ok === true &&
				isRecord(r.metrics) &&
				exactJson(r.candidate, candidate),
		)
	const entries: Record<string, unknown>[] = []
	for (const signal of EXPECTED_SIGNALS) {
		const trainResult = findPaired(trainingResults, signal)
		const heldResult = findPaired(heldOutResults, signal)
		if (!trainResult || !heldResult) return null
		const trainMetrics = trainResult.metrics as Record<string, number>
		const heldMetrics = heldResult.metrics as Record<string, number>
		const trainingLogical = trainMetrics.logicalBytes!
		const heldOutLogical = heldMetrics.logicalBytes!
		if (!(trainingLogical > 0) || !(heldOutLogical > 0)) return null
		const ratio = heldOutLogical / trainingLogical
		const comparisons = expectedComparisons(trainMetrics, heldMetrics, tolerances, policy, {
			ratio,
			metrics: new Set(["wallMs", "physicalBytes"]),
		})
		entries.push({
			signal,
			scaleRatio: ratio,
			comparisons,
			passed: comparisons.every((comparison) => comparison.withinTolerance === true),
		})
	}
	return entries
}

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

/** Validate metrics emitted by one real child, including derived-value coherence. */
const validateMeasuredMetricsRecord = (value: unknown, label: string, path: string): void => {
	validateMetricsRecord(value, label, path)
	const metrics = value as Record<string, number>
	const expectedCompression = metrics.logicalBytes! > 0 ? metrics.physicalBytes! / metrics.logicalBytes! : 0
	const expectedThroughput = metrics.wallMs! > 0 ? metrics.logicalBytes! / (metrics.wallMs! / 1000) : 0
	if (metrics.compressionRatio !== expectedCompression) {
		throw new Error(
			`invalid calibration config ${label}.compressionRatio (not physicalBytes/logicalBytes): ${path}`,
		)
	}
	if (metrics.writeThroughputBytesPerSec !== expectedThroughput) {
		throw new Error(
			`invalid calibration config ${label}.writeThroughputBytesPerSec (not logicalBytes/wallMs): ${path}`,
		)
	}
}

const SAMPLE_KEYS = new Set([
	"checkpointId",
	"checkpointManifestFingerprint",
	"rangeDate",
	"role",
	"startRow",
	"requestedRows",
	"rowCount",
])

/**
 * Validate one result's persisted sample scope. Every ok result must bind its
 * measurement to one immutable checkpoint/range and an exact ordered-row window
 * so the loader can prove training and held-out came from the same source on
 * disjoint, correctly-sized windows. `expectedRowCount` is the metrics.rowCount
 * the same result recorded (must equal sample.rowCount). Pure.
 */
const validateSampleScope = (
	value: unknown,
	label: string,
	path: string,
	expected: {
		checkpointId: string
		manifestFingerprint: string
		rangeDate: string
		role: "training" | "held-out"
		startRow: number
		requestedRows: number
	},
	expectedRowCount: number,
): void => {
	if (!isRecord(value)) throw new Error(`invalid calibration config ${label} (record required): ${path}`)
	for (const key of Object.keys(value)) {
		if (!SAMPLE_KEYS.has(key)) throw new Error(`unknown calibration config ${label}.${key}: ${path}`)
	}
	for (const key of SAMPLE_KEYS) {
		if (!(key in value)) throw new Error(`invalid calibration config ${label}.${key} (required): ${path}`)
	}
	const scope = value as Record<string, unknown>
	if (
		typeof scope.checkpointId !== "string" ||
		scope.checkpointId !== expected.checkpointId ||
		typeof scope.checkpointManifestFingerprint !== "string" ||
		scope.checkpointManifestFingerprint !== expected.manifestFingerprint ||
		typeof scope.rangeDate !== "string" ||
		scope.rangeDate !== expected.rangeDate ||
		scope.role !== expected.role ||
		typeof scope.startRow !== "number" ||
		!Number.isSafeInteger(scope.startRow) ||
		scope.startRow !== expected.startRow ||
		typeof scope.requestedRows !== "number" ||
		!Number.isSafeInteger(scope.requestedRows) ||
		scope.requestedRows !== expected.requestedRows ||
		typeof scope.rowCount !== "number" ||
		!Number.isSafeInteger(scope.rowCount) ||
		scope.rowCount !== expectedRowCount ||
		scope.rowCount !== expected.requestedRows
	) {
		throw new Error(
			`invalid calibration config ${label} (scope must bind and fully observe the exact ${expected.role} window): ${path}`,
		)
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
const validateCompleteConfigSchema = (
	parsed: Record<string, unknown>,
	path: string,
	formatVersion: SupportedTuningConfigFormatVersion,
): VerifiedCalibrationConfigDocument => {
	const knownTopLevel = new Set([
		"formatVersion",
		"effective",
		"environment",
		"selected",
		"results",
		"heldOut",
		"heldOutAttempts",
		"checkpoint",
		"candidateMatrix",
		"requiredSignals",
		"samplePolicy",
		"derivation",
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
	if (parsed.confidence !== "high") {
		throw new Error(
			`invalid calibration config: a loadable recommendation requires confidence 'high': ${path}`,
		)
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
	if (
		!Array.isArray(parsed.recalibrationTriggers) ||
		!exactJson(parsed.recalibrationTriggers, CALIBRATION_RECALIBRATION_TRIGGERS)
	) {
		throw new Error(`invalid calibration config recalibrationTriggers (exact policy required): ${path}`)
	}
	if (!Array.isArray(parsed.requiredSignals) || !exactJson(parsed.requiredSignals, EXPECTED_SIGNALS)) {
		throw new Error(`invalid calibration config requiredSignals (exact six-signal set required): ${path}`)
	}
	if (!Array.isArray(parsed.candidateMatrix) || !exactJson(parsed.candidateMatrix, EXPECTED_CANDIDATES)) {
		throw new Error(
			`invalid calibration config candidateMatrix (exact supported matrix required): ${path}`,
		)
	}
	if (!isRecord(parsed.checkpoint)) {
		throw new Error(`invalid calibration config checkpoint (record required): ${path}`)
	}
	assertExactKeys(parsed.checkpoint, new Set(["checkpointId", "manifestFingerprint"]), "checkpoint", path)
	if (
		typeof parsed.checkpoint.checkpointId !== "string" ||
		parsed.checkpoint.checkpointId.length === 0 ||
		typeof parsed.checkpoint.manifestFingerprint !== "string" ||
		parsed.checkpoint.manifestFingerprint.length === 0
	) {
		throw new Error(`invalid calibration config checkpoint identity: ${path}`)
	}
	const configCheckpoint = {
		checkpointId: parsed.checkpoint.checkpointId,
		manifestFingerprint: parsed.checkpoint.manifestFingerprint,
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
		if (!Number.isSafeInteger(budget[f]) || budget[f] === 0) {
			throw new Error(
				`invalid calibration config budget.${f} (positive safe integer required): ${path}`,
			)
		}
	}
	const budgetSafetyMargin = budget.safetyMargin
	if (typeof budgetSafetyMargin !== "number" || budgetSafetyMargin <= 0) {
		throw new Error(`invalid calibration config budget.safetyMargin (must be > 0): ${path}`)
	}
	if (parsed.safetyMargin !== budget.safetyMargin) {
		throw new Error(`invalid calibration config safetyMargin != budget.safetyMargin: ${path}`)
	}
	// samplePolicy: the disjoint training/held-out window contract. Every result
	// scope must match it exactly so the loader can prove the persisted evidence
	// came from one source on disjoint, correctly-sized windows.
	const trainingRows = budget.sampleRows as number
	const expectedHeldOutRows = heldOutSampleRows(trainingRows)
	const expectedSamplePolicy = {
		trainingRows,
		heldOutMultiplier: HELD_OUT_SAMPLE_MULTIPLIER,
		heldOutRows: expectedHeldOutRows,
		trainingWindow: `[0, ${trainingRows})`,
		heldOutWindow: `[${trainingRows}, ${trainingRows + expectedHeldOutRows})`,
	}
	if (!isRecord(parsed.samplePolicy)) {
		throw new Error(`invalid calibration config samplePolicy (record required): ${path}`)
	}
	if (!exactJson(parsed.samplePolicy, expectedSamplePolicy)) {
		throw new Error(
			`invalid calibration config samplePolicy (must bind the exact disjoint training/held-out window contract): ${path}`,
		)
	}
	if (!isRecord(parsed.selected)) {
		throw new Error(`invalid calibration config selected (record required): ${path}`)
	}
	const sel = parsed.selected
	assertExactKeys(sel, new Set(["candidate", "worstCase"]), "selected", path)
	validateCandidateRecord(sel.candidate, "selected.candidate", path)
	validateMetricsRecord(sel.worstCase, "selected.worstCase", path)

	if (!Array.isArray(parsed.results)) {
		throw new Error(`invalid calibration config results (array required): ${path}`)
	}
	if (parsed.results.length !== EXPECTED_CANDIDATES.length * EXPECTED_SIGNALS.length) {
		throw new Error(
			`invalid calibration config results (complete candidate x signal matrix required): ${path}`,
		)
	}
	const seenTraining = new Set<string>()
	const resultsByCandidate = new Map<string, Record<string, unknown>[]>()
	// Every training + held-out scope must bind to ONE rangeDate (one sealed day).
	// Extract it from the first ok result's sample; all others must match.
	let sharedRangeDate: string | null = null
	for (const r of parsed.results) {
		if (isRecord(r) && r.ok === true && isRecord(r.sample) && typeof r.sample.rangeDate === "string") {
			sharedRangeDate = r.sample.rangeDate
			break
		}
	}
	if (sharedRangeDate === null) {
		throw new Error(`invalid calibration config: no training result records a sample rangeDate: ${path}`)
	}
	for (let i = 0; i < parsed.results.length; i++) {
		const r = parsed.results[i]
		if (!isRecord(r)) {
			throw new Error(`invalid calibration config results[${i}] (record required): ${path}`)
		}
		const knownResult = new Set(["candidate", "signal", "metrics", "ok", "error", "sample"])
		for (const key of Object.keys(r)) {
			if (!knownResult.has(key)) {
				throw new Error(`unknown calibration config results[${i}].${key}: ${path}`)
			}
		}
		if (typeof r.signal !== "string" || typeof r.ok !== "boolean") {
			throw new Error(`invalid calibration config results[${i}] (signal/ok required): ${path}`)
		}
		validateCandidateRecord(r.candidate, `results[${i}].candidate`, path)
		const candidateKey = JSON.stringify(r.candidate)
		if (!EXPECTED_CANDIDATES.some((candidate) => exactJson(candidate, r.candidate))) {
			throw new Error(`invalid calibration config results[${i}].candidate (outside matrix): ${path}`)
		}
		if (!EXPECTED_SIGNALS.includes(r.signal as (typeof EXPECTED_SIGNALS)[number])) {
			throw new Error(`invalid calibration config results[${i}].signal (outside six signals): ${path}`)
		}
		const evidenceKey = `${candidateKey}\u0000${r.signal}`
		if (seenTraining.has(evidenceKey)) {
			throw new Error(`duplicate calibration config training evidence: ${path}`)
		}
		seenTraining.add(evidenceKey)
		if (r.error !== undefined && typeof r.error !== "string") {
			throw new Error(`invalid calibration config results[${i}].error: ${path}`)
		}
		if (r.ok) {
			validateMeasuredMetricsRecord(r.metrics, `results[${i}].metrics`, path)
			const metricsRow = (r.metrics as Record<string, unknown>).rowCount
			validateSampleScope(
				r.sample,
				`results[${i}].sample`,
				path,
				{
					checkpointId: configCheckpoint.checkpointId,
					manifestFingerprint: configCheckpoint.manifestFingerprint,
					rangeDate: sharedRangeDate,
					role: "training",
					startRow: 0,
					requestedRows: trainingRows,
				},
				metricsRow as number,
			)
		} else {
			if (r.metrics !== null) {
				throw new Error(
					`invalid calibration config results[${i}].metrics (failed result must be null): ${path}`,
				)
			}
			if (r.sample !== undefined) {
				throw new Error(
					`invalid calibration config results[${i}].sample (failed result must not record a scope): ${path}`,
				)
			}
		}
		const candidateResults = resultsByCandidate.get(candidateKey) ?? []
		candidateResults.push(r)
		resultsByCandidate.set(candidateKey, candidateResults)
	}
	const eligible = EXPECTED_CANDIDATES.flatMap((candidate) => {
		const evidence = resultsByCandidate.get(JSON.stringify(candidate)) ?? []
		if (
			evidence.length !== EXPECTED_SIGNALS.length ||
			!evidence.every(
				(result) =>
					result.ok === true &&
					isRecord(result.metrics) &&
					metricsMeetBudget(
						result.metrics as Record<string, number>,
						budget as Record<string, number>,
					),
			)
		) {
			return []
		}
		return [{ candidate, worstCase: worstCaseFromResults(evidence, path) }]
	}).sort(
		(a, b) =>
			a.worstCase.peakRssBytes! - b.worstCase.peakRssBytes! ||
			a.worstCase.wallMs! - b.worstCase.wallMs!,
	)
	const selectedIndex = eligible.findIndex((entry) => exactJson(entry.candidate, sel.candidate))
	if (selectedIndex < 0) {
		throw new Error(
			`invalid calibration config selected candidate did not pass training ceilings: ${path}`,
		)
	}
	if (!exactJson(eligible[selectedIndex]!.worstCase, sel.worstCase)) {
		throw new Error(
			`invalid calibration config selected.worstCase was not recomputed from results: ${path}`,
		)
	}
	if (!isRecord(parsed.heldOut)) {
		throw new Error(`invalid calibration config heldOut (record required): ${path}`)
	}
	assertExactKeys(
		parsed.heldOut,
		new Set(["results", "worstCase", "signalComparisons", "passed", "tolerances"]),
		"heldOut",
		path,
	)
	const held = parsed.heldOut
	if (!Array.isArray(held.results) || held.results.length !== EXPECTED_SIGNALS.length) {
		throw new Error(`invalid calibration config heldOut.results (six entries required): ${path}`)
	}
	const heldSeen = new Set<string>()
	for (let i = 0; i < held.results.length; i++) {
		const result = held.results[i]
		if (!isRecord(result)) throw new Error(`invalid calibration config heldOut.results[${i}]: ${path}`)
		assertExactKeys(
			result,
			new Set(["candidate", "signal", "metrics", "ok", "sample"]),
			`heldOut.results[${i}]`,
			path,
		)
		if (
			result.ok !== true ||
			typeof result.signal !== "string" ||
			heldSeen.has(result.signal) ||
			!EXPECTED_SIGNALS.includes(result.signal as (typeof EXPECTED_SIGNALS)[number]) ||
			!exactJson(result.candidate, sel.candidate)
		) {
			throw new Error(`invalid calibration config heldOut.results[${i}] identity: ${path}`)
		}
		heldSeen.add(result.signal)
		const metrics = resultMetrics(result.metrics, `heldOut.results[${i}].metrics`, path)
		if (!metricsMeetBudget(metrics, budget as Record<string, number>)) {
			throw new Error(`invalid calibration config heldOut.results[${i}] exceeds budget: ${path}`)
		}
		validateSampleScope(
			result.sample,
			`heldOut.results[${i}].sample`,
			path,
			{
				checkpointId: configCheckpoint.checkpointId,
				manifestFingerprint: configCheckpoint.manifestFingerprint,
				rangeDate: sharedRangeDate,
				role: "held-out",
				startRow: trainingRows,
				requestedRows: expectedHeldOutRows,
			},
			metrics.rowCount!,
		)
	}
	const heldWorst = worstCaseFromResults(held.results as Record<string, unknown>[], path)
	validateMetricsRecord(held.worstCase, "heldOut.worstCase", path)
	if (!exactJson(heldWorst, held.worstCase)) {
		throw new Error(`invalid calibration config heldOut.worstCase was not recomputed: ${path}`)
	}
	if (!isRecord(held.tolerances)) {
		throw new Error(`invalid calibration config heldOut.tolerances: ${path}`)
	}
	const toleranceKeys = new Set([
		"peakRssBytes",
		"wallMs",
		"writeThroughputBytesPerSec",
		"compressionRatio",
		"physicalBytes",
		"peakTempDiskBytes",
	])
	assertExactKeys(held.tolerances, toleranceKeys, "heldOut.tolerances", path)
	if (!exactJson(held.tolerances, CALIBRATION_HELD_OUT_TOLERANCES)) {
		throw new Error(`invalid calibration config heldOut.tolerances (exact policy required): ${path}`)
	}
	const validateHeldOutEvidence = (policy: HeldOutComparisonPolicy): void => {
		// PER-SIGNAL, like-for-like hybrid comparison: recompute each signal's
		// entry by pairing the selected candidate's training result with the
		// held-out result for that same signal, scaling wallMs/physicalBytes by
		// that signal's own logical-byte ratio. Aggregate extrema (heldWorst) are
		// descriptive only. The policy must be global to the document: accepting
		// a mixture would let forged evidence combine two incompatible policies.
		const recomputedSignalComparisons = expectedSignalComparisons(
			parsed.results as Record<string, unknown>[],
			held.results as Record<string, unknown>[],
			sel.candidate as Record<string, number>,
			held.tolerances as Record<string, number>,
			policy,
		)
		if (recomputedSignalComparisons === null) {
			throw new Error(
				`invalid calibration config heldOut could not pair every signal like-for-like: ${path}`,
			)
		}
		if (
			!Array.isArray(held.signalComparisons) ||
			!exactJson(recomputedSignalComparisons, held.signalComparisons)
		) {
			throw new Error(
				`invalid calibration config heldOut.signalComparisons were not recomputed: ${path}`,
			)
		}
		const heldOutPassed = recomputedSignalComparisons.every((entry) => entry.passed === true)
		if (held.passed !== true || !heldOutPassed) {
			throw new Error(`invalid calibration config heldOut did not pass every signal: ${path}`)
		}
		if (!Array.isArray(parsed.heldOutAttempts) || parsed.heldOutAttempts.length === 0) {
			throw new Error(
				`invalid calibration config heldOutAttempts (non-empty evidence required): ${path}`,
			)
		}
		for (let attemptIndex = 0; attemptIndex < parsed.heldOutAttempts.length; attemptIndex++) {
			const attempt = parsed.heldOutAttempts[attemptIndex]
			if (!isRecord(attempt)) {
				throw new Error(`invalid calibration config heldOutAttempts[${attemptIndex}]: ${path}`)
			}
			assertExactKeys(
				attempt,
				new Set(["candidate", "results", "worstCase", "signalComparisons", "passed"]),
				`heldOutAttempts[${attemptIndex}]`,
				path,
			)
			if (
				attemptIndex >= eligible.length ||
				!exactJson(attempt.candidate, eligible[attemptIndex]!.candidate) ||
				!Array.isArray(attempt.results)
			) {
				throw new Error(`invalid calibration config heldOutAttempts candidate order: ${path}`)
			}
			const attemptSignals = new Set<string>()
			let completeAndWithinBudget = attempt.results.length === EXPECTED_SIGNALS.length
			for (let resultIndex = 0; resultIndex < attempt.results.length; resultIndex++) {
				const result = attempt.results[resultIndex]
				if (!isRecord(result)) {
					throw new Error(`invalid calibration config heldOutAttempts result: ${path}`)
				}
				for (const key of Object.keys(result)) {
					if (!new Set(["candidate", "signal", "metrics", "ok", "error", "sample"]).has(key)) {
						throw new Error(`unknown calibration config heldOutAttempts result.${key}: ${path}`)
					}
				}
				if (
					typeof result.signal !== "string" ||
					attemptSignals.has(result.signal) ||
					!EXPECTED_SIGNALS.includes(result.signal as (typeof EXPECTED_SIGNALS)[number]) ||
					!exactJson(result.candidate, attempt.candidate)
				) {
					throw new Error(`invalid calibration config heldOutAttempts result identity: ${path}`)
				}
				attemptSignals.add(result.signal)
				if (result.ok === true && isRecord(result.metrics)) {
					validateMeasuredMetricsRecord(result.metrics, "heldOutAttempts.metrics", path)
					if (
						!metricsMeetBudget(
							result.metrics as Record<string, number>,
							budget as Record<string, number>,
						)
					) {
						completeAndWithinBudget = false
					}
					validateSampleScope(
						result.sample,
						`heldOutAttempts[${attemptIndex}].results[${resultIndex}].sample`,
						path,
						{
							checkpointId: configCheckpoint.checkpointId,
							manifestFingerprint: configCheckpoint.manifestFingerprint,
							rangeDate: sharedRangeDate,
							role: "held-out",
							startRow: trainingRows,
							requestedRows: expectedHeldOutRows,
						},
						(result.metrics as Record<string, unknown>).rowCount as number,
					)
				} else {
					completeAndWithinBudget = false
					if (result.metrics !== null) {
						throw new Error(`invalid calibration config heldOutAttempts failed metrics: ${path}`)
					}
					if (result.sample !== undefined) {
						throw new Error(
							`invalid calibration config heldOutAttempts failed result must not record a scope: ${path}`,
						)
					}
				}
			}
			const completeWorst = completeAndWithinBudget
				? worstCaseFromResults(attempt.results as Record<string, unknown>[], path)
				: null
			const attemptCandidate = eligible[attemptIndex]!.candidate as Record<string, number>
			// Complete attempt: recompute per-signal comparisons against this
			// candidate's training results. A non-positive logical-byte pair makes
			// the attempt incomplete under the same rule as the runner.
			const completeSignalComparisons = completeWorst
				? expectedSignalComparisons(
						parsed.results as Record<string, unknown>[],
						attempt.results as Record<string, unknown>[],
						attemptCandidate,
						held.tolerances as Record<string, number>,
						policy,
					)
				: []
			const attemptIncomplete = completeWorst === null || completeSignalComparisons === null
			const attemptWorst = attemptIncomplete ? null : completeWorst
			const attemptSignalComparisons = attemptIncomplete ? [] : completeSignalComparisons
			const attemptPassed =
				attemptWorst !== null && attemptSignalComparisons.every((entry) => entry.passed === true)
			if (
				!exactJson(attempt.worstCase, attemptWorst) ||
				!exactJson(attempt.signalComparisons, attemptSignalComparisons) ||
				attempt.passed !== attemptPassed
			) {
				throw new Error(`invalid calibration config heldOutAttempts semantic evidence: ${path}`)
			}
			if (attemptPassed && attemptIndex !== parsed.heldOutAttempts.length - 1) {
				throw new Error(
					`invalid calibration config continued after a passing held-out attempt: ${path}`,
				)
			}
		}
		const finalAttempt = parsed.heldOutAttempts[parsed.heldOutAttempts.length - 1]!
		if (
			!isRecord(finalAttempt) ||
			finalAttempt.passed !== true ||
			!exactJson(finalAttempt.candidate, sel.candidate) ||
			!exactJson(finalAttempt.results, held.results) ||
			!exactJson(finalAttempt.worstCase, held.worstCase) ||
			!exactJson(finalAttempt.signalComparisons, held.signalComparisons)
		) {
			throw new Error(
				`invalid calibration config selected held-out evidence is not final passing attempt: ${path}`,
			)
		}
	}
	const allowedPolicies: ReadonlyArray<HeldOutComparisonPolicy> =
		formatVersion === LEGACY_TUNING_CONFIG_FORMAT_VERSION ? ["directional", "symmetric"] : ["directional"]
	const validationErrors: Error[] = []
	let matchedPolicy = false
	for (const policy of allowedPolicies) {
		try {
			validateHeldOutEvidence(policy)
			matchedPolicy = true
		} catch (error) {
			validationErrors.push(error instanceof Error ? error : new Error(String(error)))
		}
	}
	if (!matchedPolicy) {
		throw validationErrors[0]!
	}
	if (!isRecord(parsed.derivation)) {
		throw new Error(`invalid calibration config derivation (record required): ${path}`)
	}
	assertExactKeys(
		parsed.derivation,
		new Set(["minFreeSpaceReserve", "targetChunkBytes"]),
		"derivation",
		path,
	)
	if (
		parsed.derivation.minFreeSpaceReserve !== "budget.freeSpaceReserve" ||
		parsed.derivation.targetChunkBytes !==
			"max(4 * selected.candidate.maxShardBytes, budget.freeSpaceReserve + selected.candidate.maxShardBytes)"
	) {
		throw new Error(`invalid calibration config tuning derivation formula: ${path}`)
	}
	if (!isRecord(parsed.effective)) {
		throw new Error(`calibration config missing 'effective' tuning block: ${path}`)
	}
	assertExactKeys(
		parsed.effective,
		new Set([
			"writerThreads",
			"rowGroupRows",
			"maxShardRows",
			"maxShardBytes",
			"targetChunkBytes",
			"minFreeSpaceReserve",
		]),
		"effective",
		path,
	)
	const selectedCandidate = sel.candidate as Record<string, number>
	const maxShardBytes = selectedCandidate.maxShardBytes!
	const freeSpaceReserve = budget.freeSpaceReserve as number
	const targetChunkBytes = Math.max(4 * maxShardBytes, freeSpaceReserve + maxShardBytes)
	if (!Number.isSafeInteger(targetChunkBytes)) {
		throw new Error(`calibration config derived targetChunkBytes overflows safe integer range: ${path}`)
	}
	const expectedEffective = {
		writerThreads: selectedCandidate.writerThreads,
		rowGroupRows: selectedCandidate.rowGroupRows,
		maxShardRows: selectedCandidate.maxShardRows,
		maxShardBytes,
		targetChunkBytes,
		minFreeSpaceReserve: budget.freeSpaceReserve,
	}
	if (!exactJson(parsed.effective, expectedEffective)) {
		throw new Error(`invalid calibration config effective values do not match exact derivation: ${path}`)
	}
	return parsed as unknown as VerifiedCalibrationConfigDocument
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
export const loadTuningConfig = (path: string): LoadedTuningConfig => {
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
	if (
		parsed.formatVersion !== LEGACY_TUNING_CONFIG_FORMAT_VERSION &&
		parsed.formatVersion !== TUNING_CONFIG_FORMAT_VERSION
	) {
		throw new Error(
			`unsupported calibration config formatVersion ${String(parsed.formatVersion)} ` +
				`(expected ${LEGACY_TUNING_CONFIG_FORMAT_VERSION} or ${TUNING_CONFIG_FORMAT_VERSION}); refusing: ${path}`,
		)
	}
	const formatVersion: SupportedTuningConfigFormatVersion =
		parsed.formatVersion === LEGACY_TUNING_CONFIG_FORMAT_VERSION
			? LEGACY_TUNING_CONFIG_FORMAT_VERSION
			: TUNING_CONFIG_FORMAT_VERSION
	// Complete strict schema validation (S10): all evidence fields required.
	const document = validateCompleteConfigSchema(parsed, path, formatVersion)
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
		identity: { formatVersion, configName, sha256 },
		document,
	}
}
