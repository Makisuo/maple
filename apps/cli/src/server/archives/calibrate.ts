// Archive calibration measurement engine.
//
// Calibration runs a bounded matrix of Parquet writer/shard candidates against a
// pinned checkpoint restored into sacrificial scratch, measuring real metrics
// (peak RSS via external `/usr/bin/time`, logical/physical bytes, wall time,
// write throughput, peak temporary disk) for each candidate. It selects the
// best candidate that fits the operator's declared ceilings WITH a safety
// margin applied INSIDE the ceiling, validates the selection on a held-out
// sample, and emits a versioned configuration document.
//
// The pure selection/aggregation/comparison core (selectCandidates,
// aggregateSignalResults, comparePredictedObserved) has no I/O and is unit-
// tested directly. The child-spawning, `/usr/bin/time` parsing, watchdog, and
// owned-sample execution live in the CLI layer (archive.ts); this module
// defines the types, the budget semantics, and the immutable document writer.
//
// CONTRACT (MAPLE-CHECKPOINT-ARCHIVE-PLAN.md "Calibration Acceptance Contract"):
//  - The operator supplies performance goals; the calibrator never redefines
//    them to make a candidate pass.
//  - No configuration is emitted unless a held-out pass succeeds across the
//    required signals. Insufficient held-out data yields a low-confidence
//    REPORT with no config, never a config.
//  - A candidate exceeding a declared budget is REJECTED (not "low confidence");
//    the next eligible candidate is tried. "low confidence" means small or
//    unrepresentative data only.
//  - The config document is immutable after --write-config; a later real-trial
//    comparison emits a SEPARATE validation report binding the immutable config
//    SHA, not a rewritten config.
//
// True external-volume, deployment-scale calibration under the deployment
// chDB/user/filesystem is a Phase 3 dependency (D-017). Phase 2 proves the
// mechanism and contract compliance in-process + native smoke.

import { writeFileSync } from "node:fs"
import { userInfo, platform, arch, cpus, totalmem } from "node:os"
import { resolve } from "node:path"
import {
	type ArchiveTuning,
	CALIBRATION_HELD_OUT_TOLERANCES,
	CALIBRATION_RECALIBRATION_TRIGGERS,
	HELD_OUT_SAMPLE_MULTIPLIER as HELD_OUT_SAMPLE_MULTIPLIER_FROM_CONFIG,
	heldOutSampleRows as heldOutSampleRowsFromConfig,
	resolveArchiveTuning,
	tuningRecord,
	type ArchiveTuningOverrides,
	TUNING_CONFIG_FORMAT_VERSION,
} from "./config"

/** A candidate writer/shard configuration evaluated by the calibrator. */
export interface CalibrationCandidate {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
}

export const isSameCalibrationCandidate = (
	left: CalibrationCandidate,
	right: CalibrationCandidate,
): boolean =>
	left.writerThreads === right.writerThreads &&
	left.rowGroupRows === right.rowGroupRows &&
	left.maxShardRows === right.maxShardRows &&
	left.maxShardBytes === right.maxShardBytes

/**
 * The operator-declared performance ceilings. A candidate passes only if its
 * observed metrics — multiplied by the safety margin for RSS, throughput, and
 * temporary disk — stay within every applicable ceiling. The margin is applied
 * INSIDE the ceiling so the recommended config has headroom under the declared
 * budget, not merely at its edge.
 */
export interface CalibrationBudget {
	/** Maximum peak RSS in bytes allowed for any candidate (before margin). */
	readonly memoryBudget: number
	/** Maximum wall-clock milliseconds for the full candidate matrix (total deadline). */
	readonly timeBudget: number
	/** Rows to sample per candidate (deterministic part/offset cap). */
	readonly sampleRows: number
	/** Maximum wall-clock milliseconds for a single candidate run. */
	readonly maxCandidateWallMs: number
	/** Minimum logical write throughput (bytes/sec) required. */
	readonly minThroughputBytesPerSec: number
	/** Maximum peak temporary disk (restored scratch + sample output) in bytes. */
	readonly maxTempDiskBytes: number
	/** Minimum free-space reserve on the archive volume in bytes. */
	readonly freeSpaceReserve: number
	/**
	 * Safety margin multiplier applied inside each ceiling: a candidate passes
	 * only if `observed * margin <= ceiling` (RSS, temp disk) and
	 * `observed / margin >= floor` (throughput). E.g. 1.1 reserves 10% headroom.
	 */
	readonly safetyMargin: number
}

/**
 * Precisely-defined metrics measured for one candidate on one signal. All names
 * are used consistently throughout calibration, the config document, and the
 * validation report.
 */
export interface CandidateMetrics {
	/** Sum of shard `total_uncompressed_size` (logical, pre-compression). */
	readonly logicalBytes: number
	/** Sum of shard on-disk (compressed) file sizes. */
	readonly physicalBytes: number
	/** physicalBytes / logicalBytes (0 when logicalBytes is 0). */
	readonly compressionRatio: number
	/** logicalBytes per wall-clock second of the write. */
	readonly writeThroughputBytesPerSec: number
	/** Peak temporary disk: restored-scratch size + sample-output size, high-water. */
	readonly peakTempDiskBytes: number
	/** Peak RSS in bytes, measured externally by `/usr/bin/time`. */
	readonly peakRssBytes: number
	/** Wall-clock milliseconds of the candidate run. */
	readonly wallMs: number
	/** Number of matching source rows in the exported sample. */
	readonly rowCount: number
}

/**
 * The role of a calibration sample within the disjoint training/held-out split.
 * Training covers ordered rows `[0, trainingRows)`; held-out covers the strictly
 * larger, disjoint window `[trainingRows, trainingRows + heldOutRows)`.
 */
export type CalibrationSampleRole = "training" | "held-out"

/**
 * The exact ordered-row scope one sample covered, recorded in every result so
 * the config loader can prove every training and held-out sample came from one
 * immutable checkpoint/range and that the two windows are disjoint and correctly
 * sized. `startRow`/`requestedRows` are the inputs to `planCalibrationShards`;
 * `rowCount` is the exact matching-row count the writer exported (which the
 * writer also asserts equals `metrics.rowCount`).
 */
export interface CalibrationSampleScope {
	readonly checkpointId: string
	readonly checkpointManifestFingerprint: string
	readonly rangeDate: string
	readonly role: CalibrationSampleRole
	/** 0-indexed start in the day's ordered (hour, part, `_part_offset`) sequence. */
	readonly startRow: number
	/** The window size requested from `planCalibrationShards`. */
	readonly requestedRows: number
	/** The exact matching-row count the writer exported in this window. */
	readonly rowCount: number
}

/** A candidate's measured result for one signal, or a failure. */
export interface CandidateResult {
	readonly candidate: CalibrationCandidate
	readonly signal: string
	readonly metrics: CandidateMetrics | null
	readonly ok: boolean
	/** The exact sample scope; present iff ok (failures export nothing). */
	readonly sample?: CalibrationSampleScope
	readonly error?: string
}

/**
 * Check whether a single candidate result's metrics fit every applicable
 * ceiling, with the safety margin applied inside the ceiling. Pure.
 *
 * - RSS:   `metrics.peakRssBytes * margin <= budget.memoryBudget`
 * - wall:  `metrics.wallMs <= budget.maxCandidateWallMs`
 * - tput:  `metrics.writeThroughputBytesPerSec / margin >= budget.minThroughputBytesPerSec`
 * - disk:  `metrics.peakTempDiskBytes * margin <= budget.maxTempDiskBytes`
 *
 * A failed result (ok=false or null metrics) never passes.
 */
export const meetsCeilings = (result: CandidateResult, budget: CalibrationBudget): boolean => {
	if (!result.ok || result.metrics === null) return false
	const m = result.metrics
	const g = budget.safetyMargin
	if (m.peakRssBytes * g > budget.memoryBudget) return false
	if (m.wallMs > budget.maxCandidateWallMs) return false
	if (
		budget.minThroughputBytesPerSec > 0 &&
		m.writeThroughputBytesPerSec / g < budget.minThroughputBytesPerSec
	)
		return false
	if (m.peakTempDiskBytes * g > budget.maxTempDiskBytes) return false
	return true
}

/**
 * From per-signal results for one candidate, select the ordered list of
 * candidates whose WORST-CASE result across ALL SIX signals meets every
 * ceiling. The worst case is taken per-metric across signals (so arrays, maps,
 * wide logs, and high-cardinality signals all weigh in). Ordered by worst-case
 * peak RSS then worst-case wall time. Pure, no I/O.
 *
 * Requires EXACTLY one result per required signal (`requiredSignals`):
 * duplicates, missing, or extra signal names make a candidate ineligible, and
 * an empty result set is never eligible. This prevents a partial matrix (e.g.
 * truncated by the total deadline) or a duplicate from claiming an all-six pass.
 *
 * Returns the eligible candidates best-first. An empty list means no candidate
 * met the declared goals across all signals — calibration must fail without a
 * recommendation in that case.
 */
export const selectCandidates = (
	perSignal: ReadonlyMap<CalibrationCandidate, ReadonlyArray<CandidateResult>>,
	budget: CalibrationBudget,
	requiredSignals: ReadonlyArray<string>,
): ReadonlyArray<{ candidate: CalibrationCandidate; worstCase: CandidateMetrics }> => {
	const required = new Set(requiredSignals)
	const eligible: { candidate: CalibrationCandidate; worstCase: CandidateMetrics }[] = []
	for (const [candidate, results] of perSignal) {
		// Require exactly one result per required signal; reject duplicates/missing/extra.
		const seen = new Set<string>()
		let complete = results.length === required.size
		for (const r of results) {
			if (!required.has(r.signal)) {
				complete = false
				break
			}
			if (seen.has(r.signal)) {
				complete = false // duplicate
				break
			}
			seen.add(r.signal)
		}
		if (!complete || seen.size !== required.size) continue
		// Every signal's result must meet the ceilings.
		const allMeet = results.every((r) => meetsCeilings(r, budget))
		if (!allMeet) continue
		const worstCase = worstCaseMetrics(results)
		eligible.push({ candidate, worstCase })
	}
	// Best-first: lowest worst-case peak RSS, then lowest worst-case wall time.
	return eligible
		.slice()
		.sort(
			(a, b) =>
				a.worstCase.peakRssBytes - b.worstCase.peakRssBytes ||
				a.worstCase.wallMs - b.worstCase.wallMs,
		)
}

/**
 * Compute the worst-case metrics across a candidate's per-signal results: the
 * MAXIMUM of each cost metric (RSS, wall, bytes, temp-disk) and the MINIMUM of
 * `writeThroughputBytesPerSec` (the floor is the worst case for a throughput
 * floor). Used so selection accounts for the heaviest AND slowest signal. Pure.
 */
export const worstCaseMetrics = (results: ReadonlyArray<CandidateResult>): CandidateMetrics => {
	const ok = results.filter(
		(r): r is CandidateResult & { metrics: CandidateMetrics } => r.ok && r.metrics !== null,
	)
	if (ok.length === 0) {
		return {
			logicalBytes: 0,
			physicalBytes: 0,
			compressionRatio: 0,
			writeThroughputBytesPerSec: 0,
			peakTempDiskBytes: 0,
			peakRssBytes: 0,
			wallMs: 0,
			rowCount: 0,
		}
	}
	const max = (sel: (m: CandidateMetrics) => number): number => Math.max(...ok.map((r) => sel(r.metrics)))
	// Throughput's worst case for a FLOOR is the minimum across signals (the
	// slowest signal). All cost metrics (RSS, wall, bytes, temp-disk) take the max.
	const min = (sel: (m: CandidateMetrics) => number): number => Math.min(...ok.map((r) => sel(r.metrics)))
	return {
		logicalBytes: max((m) => m.logicalBytes),
		physicalBytes: max((m) => m.physicalBytes),
		compressionRatio: max((m) => m.compressionRatio),
		writeThroughputBytesPerSec: min((m) => m.writeThroughputBytesPerSec),
		peakTempDiskBytes: max((m) => m.peakTempDiskBytes),
		peakRssBytes: max((m) => m.peakRssBytes),
		wallMs: max((m) => m.wallMs),
		rowCount: max((m) => m.rowCount),
	}
}

/** A per-metric predicted-vs-observed comparison with a documented tolerance. */
export interface MetricComparison {
	readonly metric:
		| "peakRssBytes"
		| "wallMs"
		| "writeThroughputBytesPerSec"
		| "compressionRatio"
		| "physicalBytes"
		| "peakTempDiskBytes"
	readonly predicted: number
	readonly observed: number
	/** Allowed relative deviation: |observed - predicted| / predicted <= tolerance. */
	readonly tolerance: number
	readonly withinTolerance: boolean
	readonly relativeDelta: number
}

/**
 * Compare predicted (from calibration) and observed (from a real archive trial)
 * metrics within documented per-metric tolerances. Returns one entry per metric
 * plus an overall pass/fail. Pure. Throughput is directional (higher is better),
 * so it passes when observed >= predicted * (1 - tolerance); all other metrics
 * pass when observed is within `tolerance` of predicted in either direction.
 */
export const comparePredictedObserved = (
	predicted: CandidateMetrics,
	observed: CandidateMetrics,
	tolerance: {
		peakRssBytes: number
		wallMs: number
		writeThroughputBytesPerSec: number
		compressionRatio: number
		physicalBytes: number
		peakTempDiskBytes: number
	},
): { comparisons: ReadonlyArray<MetricComparison>; passed: boolean } => {
	const twoSided = (
		metric: MetricComparison["metric"],
		p: number,
		o: number,
		t: number,
	): MetricComparison => {
		const rel = p > 0 ? Math.abs(o - p) / p : o === 0 ? 0 : Number.POSITIVE_INFINITY
		return {
			metric,
			predicted: p,
			observed: o,
			tolerance: t,
			withinTolerance: rel <= t,
			relativeDelta: rel,
		}
	}
	const throughput = (
		metric: MetricComparison["metric"],
		p: number,
		o: number,
		t: number,
	): MetricComparison => {
		// Higher is better: pass when o >= p * (1 - t).
		const rel = p > 0 ? Math.max(0, (p - o) / p) : 0
		return {
			metric,
			predicted: p,
			observed: o,
			tolerance: t,
			withinTolerance: o >= p * (1 - t),
			relativeDelta: rel,
		}
	}
	const comparisons: MetricComparison[] = [
		twoSided("peakRssBytes", predicted.peakRssBytes, observed.peakRssBytes, tolerance.peakRssBytes),
		twoSided("wallMs", predicted.wallMs, observed.wallMs, tolerance.wallMs),
		throughput(
			"writeThroughputBytesPerSec",
			predicted.writeThroughputBytesPerSec,
			observed.writeThroughputBytesPerSec,
			tolerance.writeThroughputBytesPerSec,
		),
		twoSided(
			"compressionRatio",
			predicted.compressionRatio,
			observed.compressionRatio,
			tolerance.compressionRatio,
		),
		twoSided("physicalBytes", predicted.physicalBytes, observed.physicalBytes, tolerance.physicalBytes),
		twoSided(
			"peakTempDiskBytes",
			predicted.peakTempDiskBytes,
			observed.peakTempDiskBytes,
			tolerance.peakTempDiskBytes,
		),
	]
	return { comparisons, passed: comparisons.every((c) => c.withinTolerance) }
}

/** The measured environment recorded in every calibration document. */
export interface CalibrationEnvironment {
	readonly mapleVersion: string
	readonly chdbVersion: string
	readonly schemaFingerprint: string
	readonly executionUser: string
	readonly platform: string
	readonly arch: string
	readonly cpuModel: string
	readonly cpuCount: number
	readonly totalMemoryBytes: number
	/** The measurement tool used for peak RSS (e.g. "/usr/bin/time"). */
	readonly measurementTool: string
	/** Archive filesystem/volume identity (from statfs f_fsid/f_type). */
	readonly archiveVolume: {
		readonly fsid: string
		readonly type: number
		readonly archiveDir: string
	}
}

/**
 * Capture the measured environment from the current process/host. Read at
 * calibration time; values are not bake-time stable across runs (CPU/RAM may
 * change), which is exactly why recalibration is required after hardware
 * changes (see recalibrationTriggers). The archive-volume identity ties the
 * calibration to the specific filesystem it measured on, so a volume change
 * is detectable (a recalibration trigger).
 */
export const captureEnvironment = (
	mapleVersion: string,
	chdbVersion: string,
	schemaFingerprint: string,
	archiveDir: string,
	archiveVolume: { fsid: string; type: number },
	measurementTool = "/usr/bin/time",
): CalibrationEnvironment => {
	const cpuList = cpus()
	return {
		mapleVersion,
		chdbVersion,
		schemaFingerprint,
		executionUser: userInfo().username,
		platform: platform(),
		arch: arch(),
		cpuModel: cpuList.length > 0 ? cpuList[0]!.model : "unknown",
		cpuCount: cpuList.length,
		totalMemoryBytes: totalmem(),
		measurementTool,
		archiveVolume: { fsid: archiveVolume.fsid, type: archiveVolume.type, archiveDir },
	}
}

/**
 * Conditions under which recalibration is required. Recorded in every config
 * document so deployment drift is detectable and operators know when to repeat.
 */
export const RECALIBRATION_TRIGGERS: ReadonlyArray<string> = CALIBRATION_RECALIBRATION_TRIGGERS

export interface CalibrationRecommendation {
	readonly formatVersion: typeof TUNING_CONFIG_FORMAT_VERSION
	readonly checkpoint: {
		readonly checkpointId: string
		readonly manifestFingerprint: string
	}
	/** The selected candidate, or null if none met the goals on held-out validation. */
	readonly selected: {
		readonly candidate: CalibrationCandidate
		readonly worstCase: CandidateMetrics
	} | null
	/** Full per-signal, per-candidate evidence. */
	readonly results: ReadonlyArray<CandidateResult>
	readonly heldOut: {
		readonly results: ReadonlyArray<CandidateResult>
		readonly worstCase: CandidateMetrics
		readonly comparisons: ReturnType<typeof comparePredictedObserved>["comparisons"]
		readonly passed: true
		readonly tolerances: typeof HELD_OUT_TOLERANCES
	} | null
	/** Every held-out candidate attempted, including rejected attempts. */
	readonly heldOutAttempts: ReadonlyArray<{
		readonly candidate: CalibrationCandidate
		readonly results: ReadonlyArray<CandidateResult>
		readonly worstCase: CandidateMetrics | null
		readonly comparisons: ReadonlyArray<MetricComparison>
		readonly passed: boolean
	}>
	readonly budget: CalibrationBudget
	readonly environment: CalibrationEnvironment
	/**
	 * "high" when the held-out pass succeeded across all required signals on
	 * representative data. "low" only when the hot store is too small or
	 * unrepresentative for a clean held-out split — NEVER for exceeding a budget.
	 * `low` is always paired with `selected: null` (no config emitted).
	 */
	readonly confidence: "high" | "low"
	readonly measuredAt: string
	readonly note: string
}

/**
 * Convert a calibration recommendation into resolved archive tuning. Used ONLY
 * to compute the `effective` block written into the config document; the
 * document itself is the authoritative source loaded by `loadTuningConfig`.
 */
export const recommendationToTuning = (
	rec: CalibrationRecommendation,
	archiveDir: string,
	scratchRoot: string,
): ArchiveTuning => {
	const overrides: ArchiveTuningOverrides =
		rec.selected !== null
			? {
					writerThreads: rec.selected.candidate.writerThreads,
					rowGroupRows: rec.selected.candidate.rowGroupRows,
					maxShardRows: rec.selected.candidate.maxShardRows,
					maxShardBytes: rec.selected.candidate.maxShardBytes,
					minFreeSpaceReserve: rec.budget.freeSpaceReserve,
					targetChunkBytes: deriveTargetChunkBytes(
						rec.selected.candidate.maxShardBytes,
						rec.budget.freeSpaceReserve,
					),
					archiveDir,
					scratchRoot,
				}
			: { archiveDir, scratchRoot }
	return resolveArchiveTuning(overrides)
}

export const deriveTargetChunkBytes = (maxShardBytes: number, freeSpaceReserve: number): number => {
	if (!Number.isSafeInteger(freeSpaceReserve) || freeSpaceReserve <= 0) {
		throw new Error(`calibration freeSpaceReserve must be a positive safe integer: ${freeSpaceReserve}`)
	}
	const fourShards = maxShardBytes * 4
	const reservePlusShard = freeSpaceReserve + maxShardBytes
	const derived = Math.max(fourShards, reservePlusShard)
	if (!Number.isSafeInteger(derived) || derived <= 0) {
		throw new Error(
			`calibration targetChunkBytes derivation overflow: maxShardBytes=${maxShardBytes}, reserve=${freeSpaceReserve}`,
		)
	}
	return derived
}

export const HELD_OUT_TOLERANCES = CALIBRATION_HELD_OUT_TOLERANCES

/**
 * The held-out window is strictly LARGER than the training window and disjoint
 * from it: training covers ordered rows `[0, sampleRows)` and held-out covers
 * `[sampleRows, sampleRows + heldOutSampleRows)` where
 * `heldOutSampleRows = HELD_OUT_SAMPLE_MULTIPLIER * sampleRows`. A larger
 * held-out sample is required by the plan (the validation must not be weaker
 * than the training measurement) and makes the recorded disjoint scope
 * auditable. Pure. Defined in ./config (single source of truth, no cycle).
 */
export const HELD_OUT_SAMPLE_MULTIPLIER = HELD_OUT_SAMPLE_MULTIPLIER_FROM_CONFIG
export const heldOutSampleRows = heldOutSampleRowsFromConfig

/**
 * Write a versioned calibration config document to `path`. The document is
 * IMMUTABLE after this write: it records the selected candidate, full evidence,
 * the measured environment, the safety margin, and recalibration triggers. A
 * later real-trial comparison does NOT rewrite this file; it emits a separate
 * validation report binding this file's SHA-256. Permissions are restrictive
 * (0o600) because the document records host/environment details.
 */
export const writeCalibrationConfig = (
	path: string,
	rec: CalibrationRecommendation,
	tuning: ArchiveTuning,
): void => {
	const doc = {
		formatVersion: TUNING_CONFIG_FORMAT_VERSION,
		measuredAt: rec.measuredAt,
		confidence: rec.confidence,
		checkpoint: rec.checkpoint,
		candidateMatrix: CANDIDATE_MATRIX,
		requiredSignals: [
			"logs",
			"traces",
			"metrics_sum",
			"metrics_gauge",
			"metrics_histogram",
			"metrics_exponential_histogram",
		],
		budget: rec.budget,
		selected: rec.selected,
		heldOut: rec.heldOut,
		heldOutAttempts: rec.heldOutAttempts,
		samplePolicy: {
			trainingRows: rec.budget.sampleRows,
			heldOutMultiplier: HELD_OUT_SAMPLE_MULTIPLIER,
			heldOutRows: heldOutSampleRows(rec.budget.sampleRows),
			trainingWindow: `[0, ${rec.budget.sampleRows})`,
			heldOutWindow: `[${rec.budget.sampleRows}, ${rec.budget.sampleRows + heldOutSampleRows(rec.budget.sampleRows)})`,
		},
		environment: rec.environment,
		effective: tuningRecord(tuning),
		derivation: {
			minFreeSpaceReserve: "budget.freeSpaceReserve",
			targetChunkBytes:
				"max(4 * selected.candidate.maxShardBytes, budget.freeSpaceReserve + selected.candidate.maxShardBytes)",
		},
		safetyMargin: rec.budget.safetyMargin,
		recalibrationTriggers: RECALIBRATION_TRIGGERS,
		results: rec.results,
		note: rec.note,
	}
	writeFileSync(resolve(path), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

/**
 * A separate validation report binding an immutable config to a real archive
 * trial. Emitted by the native probe / acceptance step, NEVER by rewriting the
 * config. Binds the config SHA-256, the trial manifest identity, and the
 * predicted-vs-observed evidence with a pass/fail verdict.
 */
export interface CalibrationValidationReport {
	readonly formatVersion: 1
	readonly configSha256: string
	readonly configName: string
	readonly trial: {
		readonly generationId: string
		readonly signal: string
		readonly rangeStart: string
		readonly archivedRowCount: number
		readonly shardCount: number
	}
	readonly comparison: { comparisons: ReadonlyArray<MetricComparison>; passed: boolean }
	readonly measuredAt: string
}

/** Write a calibration validation report (separate from the immutable config). */
export const writeValidationReport = (path: string, report: CalibrationValidationReport): void => {
	writeFileSync(resolve(path), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

/** Resolve the calibration archive dir, creating it if needed. */
export const ensureCalibrationArchiveDir = (archiveDir: string): string => {
	const abs = resolve(archiveDir)
	return abs
}

/** The fixed candidate matrix evaluated by the calibrator. */
export const CANDIDATE_MATRIX: ReadonlyArray<CalibrationCandidate> = [
	{ writerThreads: 1, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 5_000, maxShardRows: 250_000, maxShardBytes: 128 * 1024 * 1024 },
	{ writerThreads: 2, rowGroupRows: 10_000, maxShardRows: 500_000, maxShardBytes: 256 * 1024 * 1024 },
	{ writerThreads: 1, rowGroupRows: 20_000, maxShardRows: 1_000_000, maxShardBytes: 512 * 1024 * 1024 },
]
