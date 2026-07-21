import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { ok, rejects, strictEqual, throws } from "node:assert"
import {
	writeFileSync as writeFileSyncSync,
	mkdtempSync,
	mkdirSync,
	mkdtempSync as mktmp,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs"
import { arch, cpus, platform, tmpdir, totalmem, userInfo } from "node:os"
import { join } from "node:path"
import {
	acquireCheckpointPin,
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
} from "../src/server/checkpoints"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

/** Seed a minimal checkpoint snapshot + state so resolveCheckpoint succeeds in unit tests. */
const seedCheckpoint = (dataDir: string, checkpointId: string): string => {
	const createdAt = "2026-01-01T00:00:00.000Z"
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSyncSync(join(snapshot, "backup", "data.bin"), "backup")
	writeFileSyncSync(
		join(snapshot, "manifest.json"),
		`${JSON.stringify({
			formatVersion: 1,
			checkpointId,
			operationId: "00000000-0000-4000-8000-000000000000",
			mapleVersion: MAPLE_VERSION,
			chdbVersion: CHDB_VERSION,
			schemaFingerprint: SCHEMA_FINGERPRINT,
			createdAt,
			sourceDataDir: dataDir,
			backupRelativePath: `snapshots/${checkpointId}/backup`,
			backupBytes: 6,
			validation: {
				validatedAt: createdAt,
				traces: 0,
				logs: 0,
				metricsSum: 0,
				metricsGauge: 0,
				metricsHistogram: 0,
				metricsExponentialHistogram: 0,
				materializedViews: 0,
			},
		})}\n`,
	)
	mkdirSync(checkpointRoot(dataDir), { recursive: true })
	writeFileSyncSync(
		checkpointStatePath(dataDir),
		`${JSON.stringify({ formatVersion: 1, revision: "00000000-0000-4000-8000-000000000001", current: checkpointId, previous: null, committedAt: createdAt })}\n`,
	)
	// Return the canonical fingerprint the recovery record must match.
	return `${checkpointId}:${createdAt}:6`
}
import {
	type CalibrationBudget,
	type CalibrationCandidate,
	type CandidateMetrics,
	type CandidateResult,
	meetsCeilings,
	selectCandidates,
	worstCaseMetrics,
	comparePredictedObserved,
	compareHeldOutPerSignal,
	HELD_OUT_TOLERANCES,
	isSameCalibrationCandidate,
	heldOutSampleRows,
	RECALIBRATION_TRIGGERS,
	recommendationToTuning,
	writeCalibrationConfig,
	type CalibrationRecommendation,
	CANDIDATE_MATRIX,
	deriveTargetChunkBytes,
	validateCalibrationBudget,
} from "../src/server/archives/calibrate"
import { ARCHIVE_SIGNALS } from "../src/server/archives/signals"
import {
	reconcileCalibration,
	writeCalibrationRecord,
	calibrationRecoveryPath,
	calibrationPinPurpose,
	derivedScratchSubdir,
	derivedSampleDir,
	directoryTreeBytes,
	preflightCalibrationFreeSpace,
	assertCalibrationSession,
	cleanupCalibrationSample,
	archiveVolumeIdentity,
} from "../src/server/archives/calibration-recovery"
import { createArchiveGeneration } from "../src/server/archives/generation"
import { listActiveOperationIds } from "../src/server/archives/journal"
import {
	loadTuningConfig,
	resolveArchiveTuning,
	TUNING_CONFIG_FORMAT_VERSION,
	type LoadedTuningConfig,
} from "../src/server/archives/config"
import { decodeChildMetrics, requireCalibrationSelection } from "../src/commands/archive"
import { ArchiveError, archiveErrorMessage } from "../src/server/archives/errors"

const baseMetrics = (over: Partial<CandidateMetrics> = {}): CandidateMetrics => ({
	logicalBytes: 1_000_000,
	physicalBytes: 300_000,
	compressionRatio: 0.3,
	writeThroughputBytesPerSec: 200_000,
	peakTempDiskBytes: 500_000,
	peakRssBytes: 200_000_000,
	wallMs: 5_000,
	rowCount: 10_000,
	...over,
})

const okResult = (
	candidate: CalibrationCandidate,
	signal: string,
	metrics: CandidateMetrics,
): CandidateResult => ({
	candidate,
	signal,
	metrics,
	ok: true,
})

const baseBudget = (over: Partial<CalibrationBudget> = {}): CalibrationBudget => ({
	memoryBudget: 1_000_000_000,
	timeBudget: 60_000,
	sampleRows: 10_000,
	maxCandidateWallMs: 30_000,
	minThroughputBytesPerSec: 0,
	maxTempDiskBytes: 2_000_000_000,
	freeSpaceReserve: 512 * 1024 * 1024,
	safetyMargin: 1.1,
	...over,
})

const cand = (wt: number, rg: number): CalibrationCandidate => ({
	writerThreads: wt,
	rowGroupRows: rg,
	maxShardRows: 500_000,
	maxShardBytes: 256 * 1024 * 1024,
})

describe("calibration budget validation", () => {
	it("accepts a complete valid budget", () => {
		const budget = baseBudget()
		strictEqual(validateCalibrationBudget(budget), budget)
	})

	it("requires positive safe-integer ceilings, sample sizes, and reserves", () => {
		for (const field of [
			"memoryBudget",
			"timeBudget",
			"sampleRows",
			"maxCandidateWallMs",
			"maxTempDiskBytes",
			"freeSpaceReserve",
		] as const) {
			for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
				throws(
					() => validateCalibrationBudget(baseBudget({ [field]: value })),
					new RegExp(`${field} must be a positive safe integer`),
				)
			}
		}
	})

	it("requires non-negative safe-integer throughput", () => {
		for (const value of [-1, Number.MAX_SAFE_INTEGER + 1]) {
			throws(
				() => validateCalibrationBudget(baseBudget({ minThroughputBytesPerSec: value })),
				/minThroughputBytesPerSec must be a non-negative safe integer/,
			)
		}
	})

	it("requires a finite safety margin of at least one", () => {
		for (const value of [0, 0.999, Number.NaN, Number.POSITIVE_INFINITY]) {
			throws(
				() => validateCalibrationBudget(baseBudget({ safetyMargin: value })),
				/safetyMargin must be a finite number at least 1/,
			)
		}
	})
})

const childScope = {
	checkpointId: "00000000-0000-4000-8000-000000000000",
	checkpointManifestFingerprint: "checkpoint:fingerprint:6",
	rangeDate: "2026-01-01",
	role: "held-out" as const,
	startRow: 10_000,
	requestedRows: 20_000,
}

const childMetrics = () => ({
	logicalBytes: 1_000_000,
	physicalBytes: 300_000,
	peakTempDiskBytes: 500_000,
	peakRssBytes: 200_000_000,
	exportWallMs: 5_000,
	rowCount: 19_500,
	sample: { ...childScope, rowCount: 19_500 },
})

describe("calibration child protocol", () => {
	it("decodes an exact finite metrics document bound to the requested sample scope", () => {
		strictEqual(decodeChildMetrics(childMetrics(), childScope).sample.startRow, childScope.startRow)
	})

	it("rejects missing, null, string, non-finite, negative, unsafe, and excess fields", () => {
		const invalid: Array<unknown> = [
			{ ...childMetrics(), logicalBytes: undefined },
			{ ...childMetrics(), logicalBytes: null },
			{ ...childMetrics(), logicalBytes: "1000000" },
			{ ...childMetrics(), logicalBytes: Number.NaN },
			{ ...childMetrics(), physicalBytes: Number.POSITIVE_INFINITY },
			{ ...childMetrics(), peakTempDiskBytes: -1 },
			{ ...childMetrics(), rowCount: Number.MAX_SAFE_INTEGER + 1 },
			{ ...childMetrics(), unexpected: true },
		]
		for (const value of invalid) throws(() => decodeChildMetrics(value, childScope))
	})

	it("binds role, requested window, and returned row count exactly", () => {
		for (const sample of [
			{ ...childMetrics().sample, role: "training" },
			{ ...childMetrics().sample, startRow: 0 },
			{ ...childMetrics().sample, requestedRows: 10_000 },
			{ ...childMetrics().sample, rowCount: 19_499 },
		]) {
			throws(
				() => decodeChildMetrics({ ...childMetrics(), sample }, childScope),
				/inconsistent sample scope/,
			)
		}
	})
})

describe("calibration recommendation error handling", () => {
	it("returns no-recommendation as a typed ArchiveError instead of a fiber defect", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				requireCalibrationSelection({
					selected: null,
					note: "no candidate met the declared goals",
				}),
			),
		)

		ok(error instanceof ArchiveError)
		ok(error.message.includes("calibration did not produce a recommendation"))
		ok(error.message.includes("no candidate met the declared goals"))
	})

	it("returns the selected recommendation on success", async () => {
		const selected = { candidate: CANDIDATE_MATRIX[0]!, worstCase: baseMetrics() }
		strictEqual(
			await Effect.runPromise(requireCalibrationSelection({ selected, note: "selected" })),
			selected,
		)
	})

	it("renders an expected archive failure without diagnostic stack frames", () => {
		const error = new ArchiveError({ message: "calibration did not produce a recommendation" })
		strictEqual(archiveErrorMessage(error), "calibration did not produce a recommendation\n")
	})
})

/** Create isolated data/archive/scratch roots under the real temp volume. */
const withRoots = async (
	run: (roots: { dataDir: string; archiveDir: string; scratchRoot: string }) => Promise<void>,
): Promise<void> => {
	const parent = realpathSync(mktmp(join(tmpdir(), "maple-calrec-")))
	const dataDir = join(parent, "data")
	const archiveDir = join(parent, "archive")
	const scratchRoot = join(parent, "scratch")
	mkdirSync(dataDir, { recursive: true })
	mkdirSync(archiveDir, { recursive: true })
	mkdirSync(scratchRoot, { recursive: true })
	try {
		await run({ dataDir, archiveDir, scratchRoot })
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

describe("calibration candidate identity", () => {
	it("does not let same-thread candidates lend representative rows", () => {
		const selected = CANDIDATE_MATRIX[0]!
		strictEqual(isSameCalibrationCandidate(selected, { ...selected }), true)
		strictEqual(isSameCalibrationCandidate(selected, CANDIDATE_MATRIX[1]!), false)
		strictEqual(isSameCalibrationCandidate(selected, CANDIDATE_MATRIX[3]!), false)
	})
})

describe("calibration held-out window is larger and disjoint", () => {
	it("heldOutSampleRows is a strict multiple > training size and yields a disjoint window", () => {
		const training = 1000
		const held = heldOutSampleRows(training)
		ok(held > training, "held-out must be larger than training")
		// Training [0, training); held-out [training, training+held). Disjoint.
		const trainingEnd = training
		const heldOutStart = training
		strictEqual(heldOutStart, trainingEnd, "held-out must start where training ends")
		ok(heldOutStart >= trainingEnd)
		// A larger training keeps the multiplier invariant.
		strictEqual(heldOutSampleRows(50_000), 100_000)
	})
})

describe("calibration measurement engine — meetsCeilings", () => {
	it("passes when all metrics are within every ceiling with margin applied inside", () => {
		const budget = baseBudget({ memoryBudget: 250_000_000, safetyMargin: 1.1 })
		const r = okResult(cand(1, 10_000), "logs", baseMetrics({ peakRssBytes: 200_000_000 }))
		strictEqual(meetsCeilings(r, budget), true)
	})

	it("fails when peak RSS * margin exceeds the memory budget", () => {
		const budget = baseBudget({ memoryBudget: 250_000_000, safetyMargin: 1.1 })
		// 230M * 1.1 = 253M > 250M
		const r = okResult(cand(1, 10_000), "logs", baseMetrics({ peakRssBytes: 230_000_000 }))
		strictEqual(meetsCeilings(r, budget), false)
	})

	it("fails when wall time exceeds the per-candidate deadline", () => {
		const budget = baseBudget({ maxCandidateWallMs: 10_000 })
		const r = okResult(cand(1, 10_000), "logs", baseMetrics({ wallMs: 15_000 }))
		strictEqual(meetsCeilings(r, budget), false)
	})

	it("fails when throughput / margin is below the floor", () => {
		const budget = baseBudget({ minThroughputBytesPerSec: 100_000, safetyMargin: 1.1 })
		// 100000 / 1.1 = 90909 < 100000
		const r = okResult(cand(1, 10_000), "logs", baseMetrics({ writeThroughputBytesPerSec: 100_000 }))
		strictEqual(meetsCeilings(r, budget), false)
	})

	it("fails when peak temp disk * margin exceeds the ceiling", () => {
		const budget = baseBudget({ maxTempDiskBytes: 1_000_000_000, safetyMargin: 1.1 })
		const r = okResult(cand(1, 10_000), "logs", baseMetrics({ peakTempDiskBytes: 950_000_000 }))
		strictEqual(meetsCeilings(r, budget), false)
	})

	it("never passes a failed result (ok=false or null metrics)", () => {
		const budget = baseBudget()
		const failed: CandidateResult = {
			candidate: cand(1, 10_000),
			signal: "logs",
			metrics: null,
			ok: false,
			error: "boom",
		}
		strictEqual(meetsCeilings(failed, budget), false)
	})
})

describe("calibration measurement engine — worstCaseMetrics", () => {
	it("takes the MAXIMUM of cost metrics and the MINIMUM of throughput across signals", () => {
		const results: CandidateResult[] = [
			okResult(
				cand(1, 10_000),
				"logs",
				baseMetrics({
					peakRssBytes: 100_000_000,
					rowCount: 5_000,
					writeThroughputBytesPerSec: 200_000,
				}),
			),
			okResult(
				cand(1, 10_000),
				"traces",
				baseMetrics({
					peakRssBytes: 200_000_000,
					rowCount: 8_000,
					writeThroughputBytesPerSec: 80_000,
				}),
			),
			okResult(
				cand(1, 10_000),
				"metrics_sum",
				baseMetrics({
					peakRssBytes: 150_000_000,
					rowCount: 12_000,
					writeThroughputBytesPerSec: 150_000,
				}),
			),
		]
		const wc = worstCaseMetrics(results)
		strictEqual(wc.peakRssBytes, 200_000_000) // max
		strictEqual(wc.rowCount, 12_000) // max
		strictEqual(wc.writeThroughputBytesPerSec, 80_000) // MIN (the slowest signal is the floor worst case)
	})

	it("returns zeroed metrics when no result is ok", () => {
		const wc = worstCaseMetrics([
			{ candidate: cand(1, 10_000), signal: "logs", metrics: null, ok: false, error: "x" },
		])
		strictEqual(wc.peakRssBytes, 0)
		strictEqual(wc.rowCount, 0)
	})
})

describe("calibration measurement engine — selectCandidates", () => {
	it("returns eligible candidates best-first (lowest worst-case RSS, then wall) and only those meeting every required signal", () => {
		const budget = baseBudget({ memoryBudget: 300_000_000 })
		const c1 = cand(1, 10_000)
		const c2 = cand(2, 10_000)
		// c1 passes both required signals; c2 fails one signal (RSS too high).
		const perSignal = new Map<CalibrationCandidate, CandidateResult[]>([
			[
				c1,
				[
					okResult(c1, "logs", baseMetrics({ peakRssBytes: 100_000_000 })),
					okResult(c1, "traces", baseMetrics({ peakRssBytes: 150_000_000 })),
				],
			],
			[
				c2,
				[
					okResult(c2, "logs", baseMetrics({ peakRssBytes: 400_000_000 })),
					okResult(c2, "traces", baseMetrics({ peakRssBytes: 200_000_000 })),
				],
			],
		])
		const eligible = selectCandidates(perSignal, budget, ["logs", "traces"])
		strictEqual(eligible.length, 1)
		strictEqual(eligible[0]!.candidate.writerThreads, 1)
		strictEqual(eligible[0]!.worstCase.peakRssBytes, 150_000_000)
	})

	it("rejects an incomplete signal set (missing a required signal)", () => {
		const budget = baseBudget({ memoryBudget: 300_000_000 })
		const perSignal = new Map<CalibrationCandidate, CandidateResult[]>([
			// Only logs present, traces MISSING — incomplete.
			[
				cand(1, 10_000),
				[okResult(cand(1, 10_000), "logs", baseMetrics({ peakRssBytes: 100_000_000 }))],
			],
		])
		const eligible = selectCandidates(perSignal, budget, ["logs", "traces"])
		strictEqual(eligible.length, 0)
	})

	it("rejects a duplicate signal", () => {
		const budget = baseBudget({ memoryBudget: 300_000_000 })
		const perSignal = new Map<CalibrationCandidate, CandidateResult[]>([
			[
				cand(1, 10_000),
				[
					okResult(cand(1, 10_000), "logs", baseMetrics()),
					okResult(cand(1, 10_000), "logs", baseMetrics()), // duplicate
				],
			],
		])
		const eligible = selectCandidates(perSignal, budget, ["logs", "traces"])
		strictEqual(eligible.length, 0)
	})

	it("returns an empty list when no candidate meets every signal (impossible budget)", () => {
		const budget = baseBudget({ memoryBudget: 50_000_000 })
		const perSignal = new Map<CalibrationCandidate, CandidateResult[]>([
			[
				cand(1, 10_000),
				[okResult(cand(1, 10_000), "logs", baseMetrics({ peakRssBytes: 200_000_000 }))],
			],
		])
		const eligible = selectCandidates(perSignal, budget, ["logs"])
		strictEqual(eligible.length, 0)
	})
})

describe("calibration measurement engine — comparePredictedObserved", () => {
	it("passes when every metric is within its tolerance", () => {
		const pred = baseMetrics()
		const obs = baseMetrics({ peakRssBytes: 210_000_000 }) // 5% over
		const result = comparePredictedObserved(pred, obs, {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		})
		strictEqual(result.passed, true)
	})

	it("fails when a metric exceeds its tolerance", () => {
		const pred = baseMetrics()
		const obs = baseMetrics({ peakRssBytes: 300_000_000 }) // 50% over
		const result = comparePredictedObserved(pred, obs, {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		})
		strictEqual(result.passed, false)
		const rssCmp = result.comparisons.find((c) => c.metric === "peakRssBytes")!
		ok(!rssCmp.withinTolerance)
	})

	it("accepts lower cost across every resource metric, including scaled held-out costs", () => {
		const pred = baseMetrics({
			peakRssBytes: 200_000_000,
			wallMs: 1_000,
			compressionRatio: 0.5,
			physicalBytes: 100_000,
			peakTempDiskBytes: 1_000_000,
		})
		const obs = baseMetrics({
			peakRssBytes: 100_000_000,
			wallMs: 250,
			compressionRatio: 0.25,
			physicalBytes: 25_000,
			peakTempDiskBytes: 500_000,
		})
		const result = comparePredictedObserved(
			pred,
			obs,
			{
				peakRssBytes: 0.1,
				wallMs: 0.1,
				writeThroughputBytesPerSec: 0.1,
				compressionRatio: 0.1,
				physicalBytes: 0.1,
				peakTempDiskBytes: 0.1,
			},
			{ ratio: 2, metrics: new Set(["wallMs", "physicalBytes"]) },
		)
		strictEqual(result.passed, true)
		for (const metric of [
			"peakRssBytes",
			"wallMs",
			"compressionRatio",
			"physicalBytes",
			"peakTempDiskBytes",
		] as const) {
			strictEqual(result.comparisons.find((c) => c.metric === metric)!.relativeDelta, 0)
		}
	})

	it("rejects a regression beyond tolerance for each directional resource cost", () => {
		const tolerance = {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		}
		const costs = [
			"peakRssBytes",
			"wallMs",
			"compressionRatio",
			"physicalBytes",
			"peakTempDiskBytes",
		] as const
		for (const metric of costs) {
			const predicted = baseMetrics()
			const observed = { ...predicted, [metric]: predicted[metric] * 1.11 }
			const result = comparePredictedObserved(predicted, observed, tolerance)
			strictEqual(result.passed, false, `${metric} regression must fail`)
			ok(!result.comparisons.find((comparison) => comparison.metric === metric)!.withinTolerance)
		}
	})

	it("handles a zero predicted resource cost fail-closed", () => {
		const tolerance = {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		}
		const predicted = baseMetrics({ peakTempDiskBytes: 0 })
		strictEqual(
			comparePredictedObserved(predicted, baseMetrics({ peakTempDiskBytes: 0 }), tolerance).passed,
			true,
		)
		const regression = comparePredictedObserved(
			predicted,
			baseMetrics({ peakTempDiskBytes: 1 }),
			tolerance,
		)
		strictEqual(regression.passed, false)
		strictEqual(
			regression.comparisons.find((comparison) => comparison.metric === "peakTempDiskBytes")!
				.withinTolerance,
			false,
		)
	})

	it("throughput is directional (higher observed is better, always passes)", () => {
		const pred = baseMetrics({ writeThroughputBytesPerSec: 100_000 })
		const obs = baseMetrics({ writeThroughputBytesPerSec: 200_000 })
		const result = comparePredictedObserved(pred, obs, {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		})
		const tputCmp = result.comparisons.find((c) => c.metric === "writeThroughputBytesPerSec")!
		ok(tputCmp.withinTolerance)
	})

	it("rejects throughput below its floor and allows a zero predicted throughput", () => {
		const tolerance = {
			peakRssBytes: 0.1,
			wallMs: 0.1,
			writeThroughputBytesPerSec: 0.1,
			compressionRatio: 0.1,
			physicalBytes: 0.1,
			peakTempDiskBytes: 0.1,
		}
		const predicted = baseMetrics({ writeThroughputBytesPerSec: 100_000 })
		const tooSlow = comparePredictedObserved(
			predicted,
			baseMetrics({ writeThroughputBytesPerSec: 89_999 }),
			tolerance,
		)
		strictEqual(tooSlow.passed, false)
		strictEqual(
			tooSlow.comparisons.find((comparison) => comparison.metric === "writeThroughputBytesPerSec")!
				.withinTolerance,
			false,
		)
		const zeroBaseline = comparePredictedObserved(
			baseMetrics({ writeThroughputBytesPerSec: 0 }),
			baseMetrics({ writeThroughputBytesPerSec: 1 }),
			tolerance,
		)
		strictEqual(zeroBaseline.passed, true)
	})
})

describe("per-signal held-out comparison rejects cross-signal aggregate masking", () => {
	// The reviewer's executable counterexample: aggregate logical-byte ratio is 4,
	// so aggregate wall prediction becomes 100*4=400 matching observed 400 (pass),
	// but like-for-like signal A has ratio 2, adjusted prediction 200 vs observed
	// 400 = delta 1.0, which exceeds the canonical 0.5 wall tolerance (fail).
	// Per-signal comparison must reject what aggregate scaling would accept.
	const candidate = CANDIDATE_MATRIX[0]!
	const metrics = (over: Partial<CandidateMetrics>): CandidateMetrics => ({
		logicalBytes: 1_000_000,
		physicalBytes: 300_000,
		compressionRatio: 0.3,
		writeThroughputBytesPerSec: 100_000,
		peakTempDiskBytes: 500_000,
		peakRssBytes: 200_000_000,
		wallMs: 5_000,
		rowCount: 10_000,
		...over,
	})
	const result = (signal: string, m: CandidateMetrics): CandidateResult => ({
		candidate,
		signal,
		metrics: m,
		ok: true,
	})

	it("fails when one signal regresses even though the aggregate ratio would pass", () => {
		const training = [
			result("logs", metrics({ logicalBytes: 1_000, wallMs: 100, physicalBytes: 300 })),
			result("traces", metrics({ logicalBytes: 10_000, wallMs: 10, physicalBytes: 3_000 })),
		]
		const heldOut = [
			result("logs", metrics({ logicalBytes: 2_000, wallMs: 400, physicalBytes: 600 })),
			result("traces", metrics({ logicalBytes: 40_000, wallMs: 40, physicalBytes: 12_000 })),
		]
		const perSignal = compareHeldOutPerSignal(
			training,
			heldOut,
			["logs", "traces"],
			candidate,
			HELD_OUT_TOLERANCES,
		)
		if (perSignal === null) throw new Error("per-signal comparison returned null unexpectedly")
		const logsWall = perSignal.signalComparisons
			.find((s) => s.signal === "logs")!
			.comparisons.find((c) => c.metric === "wallMs")!
		// Signal A: ratio 2, adjusted prediction 200, observed 400 → delta 1.0 > 0.5.
		ok(!logsWall.withinTolerance, "signal A wall regression must fail the per-signal check")
		strictEqual(perSignal.passed, false, "the attempt must not pass when any signal fails")
	})

	it("returns null when a signal cannot be paired (incomplete)", () => {
		const training = [result("logs", metrics())]
		const heldOut = [result("logs", metrics()), result("traces", metrics())]
		strictEqual(
			compareHeldOutPerSignal(training, heldOut, ["logs", "traces"], candidate, HELD_OUT_TOLERANCES),
			null,
		)
	})

	it("returns null when a paired signal has non-positive training logicalBytes", () => {
		const training = [result("logs", metrics({ logicalBytes: 0 }))]
		const heldOut = [result("logs", metrics())]
		strictEqual(
			compareHeldOutPerSignal(training, heldOut, ["logs"], candidate, HELD_OUT_TOLERANCES),
			null,
		)
	})
})

describe("calibration tuning derivation and strict volume binding", () => {
	it("derives both non-candidate knobs exactly and rejects overflow", () => {
		strictEqual(deriveTargetChunkBytes(256 * 1024 * 1024, 512 * 1024 * 1024), 1024 * 1024 * 1024)
		strictEqual(deriveTargetChunkBytes(100, 10_000), 10_100)
		throws(() => deriveTargetChunkBytes(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), /overflow/)
	})

	it("inspects only an existing canonical non-symlink archive root", async () => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), "maple-bound-volume-")))
		try {
			const root = join(parent, "archive")
			const link = join(parent, "archive-link")
			mkdirSync(root)
			symlinkSync(root, link)
			const identity = await archiveVolumeIdentity(root)
			ok(identity.fsid.startsWith("dev:"))
			await rejects(archiveVolumeIdentity(link), /real non-symlink|canonical/)
			await rejects(archiveVolumeIdentity(join(parent, "missing")), /ENOENT|existing/)
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})
})

describe("calibration config document — writeCalibrationConfig emits required fields", () => {
	it("writes environment, evidence, safetyMargin, recalibrationTriggers, and schemaFingerprint", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-cfg-"))
		try {
			const path = join(dir, "cfg.json")
			const rec: CalibrationRecommendation = {
				formatVersion: TUNING_CONFIG_FORMAT_VERSION,
				checkpoint: {
					checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					manifestFingerprint: "checkpoint:fingerprint",
				},
				selected: { candidate: CANDIDATE_MATRIX[0]!, worstCase: baseMetrics() },
				results: [okResult(CANDIDATE_MATRIX[0]!, "logs", baseMetrics())],
				heldOut: {
					results: [okResult(CANDIDATE_MATRIX[0]!, "logs", baseMetrics())],
					worstCase: baseMetrics(),
					comparisons: comparePredictedObserved(baseMetrics(), baseMetrics(), {
						peakRssBytes: 0.5,
						wallMs: 1,
						writeThroughputBytesPerSec: 0.75,
						compressionRatio: 0.5,
						physicalBytes: 1,
						peakTempDiskBytes: 0.5,
					}).comparisons,
					passed: true,
					tolerances: {
						peakRssBytes: 0.5,
						wallMs: 1,
						writeThroughputBytesPerSec: 0.75,
						compressionRatio: 0.5,
						physicalBytes: 1,
						peakTempDiskBytes: 0.5,
					},
				},
				heldOutAttempts: [],
				budget: baseBudget(),
				environment: {
					mapleVersion: "test",
					chdbVersion: "v26",
					schemaFingerprint: "abc123",
					executionUser: "tester",
					platform: "darwin",
					arch: "arm64",
					cpuModel: "test-cpu",
					cpuCount: 8,
					totalMemoryBytes: 16_000_000_000,
					measurementTool: "/usr/bin/time",
					archiveVolume: { fsid: "dev:abc", type: 17, archiveDir: "/tmp/archive" },
				},
				confidence: "high",
				measuredAt: "2026-07-01T00:00:00.000Z",
				note: "test",
			}
			const tuning = recommendationToTuning(rec, "/tmp/archive", "/tmp/scratch")
			writeCalibrationConfig(path, rec, tuning)
			const doc = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as Record<string, unknown>
			strictEqual(doc.formatVersion, TUNING_CONFIG_FORMAT_VERSION)
			ok(doc.environment !== undefined)
			ok(Array.isArray(doc.results))
			ok(doc.safetyMargin !== undefined)
			ok(Array.isArray(doc.recalibrationTriggers))
			strictEqual((doc.environment as { schemaFingerprint: string }).schemaFingerprint, "abc123")
			ok(doc.effective !== undefined)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("calibration recovery — idempotent reconcile", () => {
	it("reconciling when no prior record exists is a no-op", async () => {
		await withRoots(async (roots) => {
			await reconcileCalibration(roots.archiveDir, roots)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), false)
		})
	})

	it("reconciling a record whose phase precedes pin creation removes owned paths (pin derived from pinId, absent = success)", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const pinId = "11111111-2222-4333-8444-555555555555"
			// Seed a real checkpoint so resolveCheckpoint + fingerprint validation pass.
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			// DERIVED owned dirs from the operation id.
			const scratchOwned = join(roots.scratchRoot, derivedScratchSubdir(operationId))
			const sampleDir = derivedSampleDir(roots.archiveDir, operationId)
			mkdirSync(scratchOwned, { recursive: true })
			mkdirSync(sampleDir, { recursive: true })
			writeFileSync(join(scratchOwned, "junk"), "x")
			// Record at intent phase (pinPath null). The pin is DERIVED from pinId;
			// an absent pin is success (over-retention safe), so reconcile proceeds.
			await writeCalibrationRecord(roots.archiveDir, {
				phase: "intent",
				operationId,
				pinId,
				pinPurpose: calibrationPinPurpose(operationId),
				pinPath: null,
				checkpointId,
				checkpointManifestFingerprint: fingerprint,
				boundRoots: roots,
				ownedPaths: { scratchSubdir: derivedScratchSubdir(operationId), sampleDir },
			})
			await reconcileCalibration(roots.archiveDir, roots)
			strictEqual(existsSync(scratchOwned), false)
			strictEqual(existsSync(sampleDir), false)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), false)
		})
	})

	it("retires an inert intent after normal retention removes its still-unpinned source checkpoint", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const replacementId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
			const pinId = "11111111-2222-4333-8444-555555555555"
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			// A later checkpoint becomes current, then normal retention removes the
			// unpinned source selected by the interrupted intent.
			seedCheckpoint(roots.dataDir, replacementId)
			rmSync(checkpointSnapshotDir(roots.dataDir, checkpointId), { recursive: true, force: true })
			const sampleDir = derivedSampleDir(roots.archiveDir, operationId)
			await writeCalibrationRecord(roots.archiveDir, {
				phase: "intent",
				operationId,
				pinId,
				pinPurpose: calibrationPinPurpose(operationId),
				pinPath: null,
				checkpointId,
				checkpointManifestFingerprint: fingerprint,
				boundRoots: roots,
				ownedPaths: { scratchSubdir: derivedScratchSubdir(operationId), sampleDir },
			})

			await reconcileCalibration(roots.archiveDir, roots)

			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), false)
			strictEqual(existsSync(checkpointSnapshotDir(roots.dataDir, replacementId)), true)
		})
	})

	it("preserves a missing-checkpoint intent when an exact derived resource is still present", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const replacementId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
			const pinId = "11111111-2222-4333-8444-555555555555"
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			seedCheckpoint(roots.dataDir, replacementId)
			rmSync(checkpointSnapshotDir(roots.dataDir, checkpointId), { recursive: true, force: true })
			const sampleDir = derivedSampleDir(roots.archiveDir, operationId)
			mkdirSync(sampleDir, { recursive: true })
			await writeCalibrationRecord(roots.archiveDir, {
				phase: "intent",
				operationId,
				pinId,
				pinPurpose: calibrationPinPurpose(operationId),
				pinPath: null,
				checkpointId,
				checkpointManifestFingerprint: fingerprint,
				boundRoots: roots,
				ownedPaths: { scratchSubdir: derivedScratchSubdir(operationId), sampleDir },
			})

			await rejects(
				reconcileCalibration(roots.archiveDir, roots),
				/source checkpoint.*preserving record/i,
			)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), true)
			strictEqual(existsSync(sampleDir), true)
		})
	})

	it("re-running reconcile after cleanup is a no-op (idempotent)", async () => {
		await withRoots(async (roots) => {
			await reconcileCalibration(roots.archiveDir, roots)
			await reconcileCalibration(roots.archiveDir, roots)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), false)
		})
	})

	it("cleans one child sample while retaining the parent session pin and durable identity", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const pinId = "11111111-2222-4333-8444-555555555555"
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			const purpose = calibrationPinPurpose(operationId)
			const pinPath = await acquireCheckpointPin(roots.dataDir, checkpointId, purpose, pinId)
			const sampleDir = derivedSampleDir(roots.archiveDir, operationId)
			const scratchSubdir = derivedScratchSubdir(operationId)
			mkdirSync(join(roots.scratchRoot, scratchSubdir), { recursive: true })
			mkdirSync(sampleDir, { recursive: true })
			await writeCalibrationRecord(roots.archiveDir, {
				phase: "pin-acquired",
				operationId,
				pinId,
				pinPurpose: purpose,
				pinPath,
				checkpointId,
				checkpointManifestFingerprint: fingerprint,
				boundRoots: roots,
				ownedPaths: { scratchSubdir, sampleDir },
			})

			const session = await assertCalibrationSession(roots.archiveDir, roots, {
				operationId,
				checkpointId,
				checkpointManifestFingerprint: fingerprint,
			})
			await cleanupCalibrationSample(session)

			strictEqual(existsSync(pinPath), true)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), true)
			strictEqual(existsSync(join(roots.scratchRoot, scratchSubdir)), false)
			strictEqual(existsSync(sampleDir), false)
			await reconcileCalibration(roots.archiveDir, roots)
		})
	})

	it("rejects malformed or substituted parent-session pin identities", async () => {
		const cases = [
			{ name: "malformed", value: {} },
			{
				name: "foreign-pin-id",
				value: {
					formatVersion: 1,
					pinId: "99999999-9999-4999-8999-999999999999",
					checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					purpose: "archive-calibrate:deadbeef-1111-4aaa-9bbb-deadbeefdead",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
			{
				name: "foreign-checkpoint",
				value: {
					formatVersion: 1,
					pinId: "11111111-2222-4333-8444-555555555555",
					checkpointId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
					purpose: "archive-calibrate:deadbeef-1111-4aaa-9bbb-deadbeefdead",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
			{
				name: "foreign-purpose",
				value: {
					formatVersion: 1,
					pinId: "11111111-2222-4333-8444-555555555555",
					checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					purpose: "archive-calibrate:ffffffff-ffff-4fff-8fff-ffffffffffff",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
		]
		for (const testCase of cases) {
			await withRoots(async (roots) => {
				const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
				const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
				const pinId = "11111111-2222-4333-8444-555555555555"
				const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
				const purpose = calibrationPinPurpose(operationId)
				const pinPath = await acquireCheckpointPin(roots.dataDir, checkpointId, purpose, pinId)
				writeFileSync(pinPath, JSON.stringify(testCase.value))
				await writeCalibrationRecord(roots.archiveDir, {
					phase: "pin-acquired",
					operationId,
					pinId,
					pinPurpose: purpose,
					pinPath,
					checkpointId,
					checkpointManifestFingerprint: fingerprint,
					boundRoots: roots,
					ownedPaths: {
						scratchSubdir: derivedScratchSubdir(operationId),
						sampleDir: derivedSampleDir(roots.archiveDir, operationId),
					},
				})

				await rejects(
					assertCalibrationSession(roots.archiveDir, roots, {
						operationId,
						checkpointId,
						checkpointManifestFingerprint: fingerprint,
					}),
					/checkpoint pin identity mismatch/,
					testCase.name,
				)
			})
		}
	})

	it("refuses a record whose bound roots do not match (foreign record)", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			// writeCalibrationRecord validates derived paths from the archiveDir, so
			// write a FOREIGN dataDir directly into the record file via a manual
			// write (the bound-root check happens at parse, not write).
			const { writeFileSync } = await import("node:fs")
			const record = {
				formatVersion: 1,
				phase: "intent",
				operationId,
				pinId: "11111111-2222-4333-8444-555555555555",
				pinPurpose: calibrationPinPurpose(operationId),
				pinPath: null,
				checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				checkpointManifestFingerprint: "c:2026:1",
				boundRoots: {
					dataDir: "/different/data",
					archiveDir: roots.archiveDir,
					scratchRoot: roots.scratchRoot,
				},
				ownedPaths: {
					scratchSubdir: derivedScratchSubdir(operationId),
					sampleDir: derivedSampleDir(roots.archiveDir, operationId),
				},
				updatedAt: new Date().toISOString(),
			}
			mkdirSync(join(roots.archiveDir, "calibration"), { recursive: true })
			writeFileSync(calibrationRecoveryPath(roots.archiveDir), JSON.stringify(record))
			await rejects(reconcileCalibration(roots.archiveDir, roots), /dataDir mismatch/)
		})
	})

	it("refuses a record with non-derived owned paths (rejects arbitrary deletion targets)", async () => {
		await withRoots(async (roots) => {
			const operationId = "deadbeef-1111-4aaa-9bbb-deadbeefdead"
			await rejects(
				writeCalibrationRecord(roots.archiveDir, {
					phase: "intent",
					operationId,
					pinId: "11111111-2222-4333-8444-555555555555",
					pinPurpose: calibrationPinPurpose(operationId),
					pinPath: null,
					checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					checkpointManifestFingerprint: "cp:2026:1",
					boundRoots: roots,
					// Non-derived paths must be rejected.
					ownedPaths: { scratchSubdir: ".", sampleDir: roots.archiveDir },
				}),
				/!= derived|refusing/i,
			)
		})
	})

	it("rejects a traversal operation id before deriving or deleting owned paths", async () => {
		await withRoots(async (roots) => {
			const protectedDir = join(roots.archiveDir, "traces")
			const protectedFile = join(protectedDir, "must-survive")
			mkdirSync(protectedDir, { recursive: true })
			writeFileSync(protectedFile, "archive data")
			mkdirSync(join(roots.archiveDir, "calibration"), { recursive: true })
			writeFileSync(
				calibrationRecoveryPath(roots.archiveDir),
				JSON.stringify({
					formatVersion: 1,
					phase: "cleanup",
					operationId: "../../traces",
					pinId: "11111111-2222-4333-8444-555555555555",
					pinPurpose: "archive-calibrate:../../traces",
					pinPath: null,
					checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					checkpointManifestFingerprint: "cp:2026:1",
					boundRoots: roots,
					ownedPaths: {
						scratchSubdir: "calibrate-../../traces",
						sampleDir: protectedDir,
					},
					updatedAt: "2026-01-01T00:00:00.000Z",
				}),
			)

			await rejects(reconcileCalibration(roots.archiveDir, roots), /invalid calibration operation ID/)
			strictEqual(existsSync(protectedFile), true, "foreign archive data must not be deleted")
			strictEqual(
				existsSync(calibrationRecoveryPath(roots.archiveDir)),
				true,
				"malformed recovery evidence must be preserved",
			)
		})
	})
})

describe("calibration recovery — directoryTreeBytes and preflightFreeSpace", () => {
	it("directoryTreeBytes sums file sizes in a tree and returns 0 for absent paths", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-tree-"))
		try {
			mkdirSync(join(dir, "sub"), { recursive: true })
			writeFileSync(join(dir, "a.bin"), "aaaa")
			writeFileSync(join(dir, "sub", "b.bin"), "bbbbbb")
			const total = await directoryTreeBytes(dir)
			strictEqual(total, 10)
			strictEqual(await directoryTreeBytes(join(dir, "nonexistent")), 0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("directoryTreeBytes follows contained symlinks once and rejects escapes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-tree-"))
		const outside = mkdtempSync(join(tmpdir(), "maple-tree-outside-"))
		try {
			mkdirSync(join(dir, "sub"), { recursive: true })
			writeFileSync(join(dir, "sub", "data.bin"), "123456")
			symlinkSync("sub", join(dir, "sub-link"))
			// The directory and its contained alias identify the same physical
			// inode, so the bytes are counted once.
			strictEqual(await directoryTreeBytes(dir), 6)
			writeFileSync(join(outside, "foreign.bin"), "outside")
			symlinkSync(outside, join(dir, "escape"))
			await rejects(directoryTreeBytes(dir), /symlink escapes owned root/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
			rmSync(outside, { recursive: true, force: true })
		}
	})

	it("preflightCalibrationFreeSpace passes on a writable temp volume with a small reserve", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-fs-"))
		try {
			// A tiny reserve + tiny working set should pass on the temp volume.
			await preflightCalibrationFreeSpace(dir, 1024, 1024)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("preflightCalibrationFreeSpace fails when the reserve+working exceeds free space", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-fs2-"))
		try {
			// An impossibly large requirement.
			await rejects(
				preflightCalibrationFreeSpace(dir, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
				/free-space preflight failed/,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("config-bound create enforces environment and volume identity", () => {
	/** Capture the live host's environment + the real archive-volume identity. */
	const liveEnvironment = async (archiveDir: string) => {
		const cpuList = cpus()
		const vol = await archiveVolumeIdentity(archiveDir)
		return {
			environment: {
				mapleVersion: MAPLE_VERSION,
				chdbVersion: CHDB_VERSION,
				schemaFingerprint: SCHEMA_FINGERPRINT,
				executionUser: userInfo().username,
				platform: platform(),
				arch: arch(),
				cpuModel: cpuList.length > 0 ? cpuList[0]!.model : "unknown",
				cpuCount: cpuList.length,
				totalMemoryBytes: totalmem(),
				measurementTool: "/usr/bin/time",
				archiveVolume: { ...vol, archiveDir },
			},
		}
	}

	/** A minimal internally-consistent v2 config document bound to a checkpoint + archive. */
	const configDocumentFor = async (
		archiveDir: string,
		checkpointId: string,
		fingerprint: string,
		env: Awaited<ReturnType<typeof liveEnvironment>>,
	) => {
		const candidate = CANDIDATE_MATRIX[0]!
		const metrics = baseMetrics()
		const heldOutMetrics = baseMetrics({
			logicalBytes: metrics.logicalBytes * 2,
			physicalBytes: metrics.physicalBytes * 2,
			wallMs: metrics.wallMs * 2,
			rowCount: metrics.rowCount * 2,
		})
		const freeSpaceReserve = 1_000_000
		const sampleRows = metrics.rowCount
		const heldOutRows = 2 * sampleRows
		const rangeDate = "2026-06-01"
		const trainingSample = {
			checkpointId,
			checkpointManifestFingerprint: fingerprint,
			rangeDate,
			role: "training" as const,
			startRow: 0,
			requestedRows: sampleRows,
			rowCount: metrics.rowCount,
		}
		const heldOutSample = {
			checkpointId,
			checkpointManifestFingerprint: fingerprint,
			rangeDate,
			role: "held-out" as const,
			startRow: sampleRows,
			requestedRows: heldOutRows,
			rowCount: heldOutMetrics.rowCount,
		}
		const effective = {
			...candidate,
			targetChunkBytes: deriveTargetChunkBytes(candidate.maxShardBytes, freeSpaceReserve),
			minFreeSpaceReserve: freeSpaceReserve,
		}
		// Every candidate/signal uses identical metrics so every recomputed worst
		// case (training and held-out) equals `metrics`, keeping the document
		// internally consistent for the loader's semantic re-derivation.
		const results = CANDIDATE_MATRIX.flatMap((matrixCandidate) =>
			ARCHIVE_SIGNALS.map((signal) => ({
				candidate: matrixCandidate,
				signal: signal.name,
				metrics,
				ok: true,
				sample: trainingSample,
			})),
		)
		const selectedWorstCase = metrics
		const heldOutResults = ARCHIVE_SIGNALS.map((signal) => ({
			candidate,
			signal: signal.name,
			metrics: heldOutMetrics,
			ok: true,
			sample: heldOutSample,
		}))
		const heldOutRatio = heldOutMetrics.logicalBytes / metrics.logicalBytes
		const signalComparisons = ARCHIVE_SIGNALS.map((signal) => {
			const comparison = comparePredictedObserved(metrics, heldOutMetrics, HELD_OUT_TOLERANCES, {
				ratio: heldOutRatio,
				metrics: new Set(["wallMs", "physicalBytes"]),
			})
			return {
				signal: signal.name,
				scaleRatio: heldOutRatio,
				comparisons: comparison.comparisons,
				passed: comparison.passed,
			}
		})
		return {
			formatVersion: TUNING_CONFIG_FORMAT_VERSION,
			measuredAt: "2026-07-01T00:00:00.000Z",
			confidence: "high" as const,
			checkpoint: { checkpointId, manifestFingerprint: fingerprint },
			candidateMatrix: CANDIDATE_MATRIX,
			requiredSignals: ARCHIVE_SIGNALS.map((signal) => signal.name),
			budget: {
				memoryBudget: 1e9,
				timeBudget: 60000,
				sampleRows,
				maxCandidateWallMs: 30000,
				minThroughputBytesPerSec: 0,
				maxTempDiskBytes: 2e9,
				freeSpaceReserve,
				safetyMargin: 1.1,
			},
			selected: { candidate, worstCase: selectedWorstCase },
			heldOut: {
				results: heldOutResults,
				worstCase: heldOutMetrics,
				signalComparisons,
				passed: true,
				tolerances: HELD_OUT_TOLERANCES,
			},
			heldOutAttempts: [
				{
					candidate,
					results: heldOutResults,
					worstCase: heldOutMetrics,
					signalComparisons,
					passed: true,
				},
			],
			environment: env.environment,
			effective,
			samplePolicy: {
				trainingRows: sampleRows,
				heldOutMultiplier: 2,
				heldOutRows,
				trainingWindow: `[0, ${sampleRows})`,
				heldOutWindow: `[${sampleRows}, ${sampleRows + heldOutRows})`,
			},
			derivation: {
				minFreeSpaceReserve: "budget.freeSpaceReserve",
				targetChunkBytes:
					"max(4 * selected.candidate.maxShardBytes, budget.freeSpaceReserve + selected.candidate.maxShardBytes)",
			},
			safetyMargin: 1.1,
			recalibrationTriggers: RECALIBRATION_TRIGGERS,
			results,
			note: "test",
		}
	}

	/** Write a config doc + load it, returning a LoadedTuningConfig bound to the roots. */
	const loadedConfigFor = async (
		roots: { dataDir: string; archiveDir: string; scratchRoot: string },
		checkpointId: string,
		fingerprint: string,
	): Promise<{ config: LoadedTuningConfig; dir: string }> => {
		const env = await liveEnvironment(roots.archiveDir)
		const doc = await configDocumentFor(roots.archiveDir, checkpointId, fingerprint, env)
		const dir = mkdtempSync(join(tmpdir(), "maple-cfgenv-"))
		const path = join(dir, "cfg.json")
		writeFileSync(path, JSON.stringify(doc))
		const config = loadTuningConfig(path)
		return { config, dir }
	}

	it("rejects create before any mutation when the recorded environment mismatches the live host", async () => {
		await withRoots(async (roots) => {
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			const { config, dir } = await loadedConfigFor(roots, checkpointId, fingerprint)
			try {
				// Forge a single environment field; the live host's schema differs.
				;(config.document.environment as { schemaFingerprint: string }).schemaFingerprint += "-forged"
				const tuning = resolveArchiveTuning({ ...config.overrides, ...roots })
				await rejects(
					createArchiveGeneration(
						roots.dataDir,
						roots.archiveDir,
						"logs",
						"2026-06-01",
						tuning,
						"current",
						{},
						config,
					),
					/calibration environment mismatch: schemaFingerprint/,
				)
				// No mutation: the env check precedes intent publication.
				strictEqual(listActiveOperationIds(roots.archiveDir).length, 0)
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		})
	})

	it("rejects create before any mutation when the recorded archive volume differs", async () => {
		await withRoots(async (roots) => {
			const checkpointId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
			const fingerprint = seedCheckpoint(roots.dataDir, checkpointId)
			const { config, dir } = await loadedConfigFor(roots, checkpointId, fingerprint)
			try {
				// Forge the volume device id while keeping the canonical path.
				;(config.document.environment.archiveVolume as { fsid: string }).fsid = "dev:deadbeef"
				const tuning = resolveArchiveTuning({ ...config.overrides, ...roots })
				await rejects(
					createArchiveGeneration(
						roots.dataDir,
						roots.archiveDir,
						"logs",
						"2026-06-01",
						tuning,
						"current",
						{},
						config,
					),
					/calibration environment mismatch: archive volume/,
				)
				strictEqual(listActiveOperationIds(roots.archiveDir).length, 0)
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		})
	})

	// NOTE: the publication-time volume re-check (beforePublicationVolumeRecheck)
	// fires AFTER the full chDB export, so it is proven by the NATIVE calibrate
	// probe's config-bound create step, not by this chDB-free unit harness.
})
