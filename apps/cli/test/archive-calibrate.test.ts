import { describe, it } from "@effect/vitest"
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
	HELD_OUT_TOLERANCES,
	isSameCalibrationCandidate,
	heldOutSampleRows,
	RECALIBRATION_TRIGGERS,
	recommendationToTuning,
	writeCalibrationConfig,
	type CalibrationRecommendation,
	CANDIDATE_MATRIX,
	deriveTargetChunkBytes,
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
	type LoadedTuningConfig,
} from "../src/server/archives/config"

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
				formatVersion: 2,
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
			strictEqual(doc.formatVersion, 2)
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
			const operationId = "x-y-z-w"
			// writeCalibrationRecord validates derived paths from the archiveDir, so
			// write a FOREIGN dataDir directly into the record file via a manual
			// write (the bound-root check happens at parse, not write).
			const { writeFileSync } = await import("node:fs")
			const record = {
				formatVersion: 1,
				phase: "intent",
				operationId,
				pinId: "p",
				pinPurpose: calibrationPinPurpose(operationId),
				pinPath: null,
				checkpointId: "c",
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
			await rejects(
				writeCalibrationRecord(roots.archiveDir, {
					phase: "intent",
					operationId: "op-x",
					pinId: "pin-x",
					pinPurpose: calibrationPinPurpose("op-x"),
					pinPath: null,
					checkpointId: "cp-x",
					checkpointManifestFingerprint: "cp:2026:1",
					boundRoots: roots,
					// Non-derived paths must be rejected: scratchSubdir !== calibrate-op-x.
					ownedPaths: { scratchSubdir: ".", sampleDir: roots.archiveDir },
				}),
				/!= derived|refusing/i,
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
		const freeSpaceReserve = 1_000_000
		const sampleRows = 1000
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
			rowCount: metrics.rowCount,
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
			metrics,
			ok: true,
			sample: heldOutSample,
		}))
		return {
			formatVersion: 2,
			measuredAt: "2026-07-01T00:00:00.000Z",
			confidence: "high" as const,
			checkpoint: { checkpointId, manifestFingerprint: fingerprint },
			candidateMatrix: CANDIDATE_MATRIX,
			requiredSignals: ARCHIVE_SIGNALS.map((signal) => signal.name),
			budget: {
				memoryBudget: 1e9,
				timeBudget: 60000,
				sampleRows: 1000,
				maxCandidateWallMs: 30000,
				minThroughputBytesPerSec: 0,
				maxTempDiskBytes: 2e9,
				freeSpaceReserve,
				safetyMargin: 1.1,
			},
			selected: { candidate, worstCase: selectedWorstCase },
			heldOut: {
				results: heldOutResults,
				worstCase: metrics,
				comparisons: comparePredictedObserved(selectedWorstCase, metrics, HELD_OUT_TOLERANCES)
					.comparisons,
				passed: true,
				tolerances: HELD_OUT_TOLERANCES,
			},
			heldOutAttempts: [
				{
					candidate,
					results: heldOutResults,
					worstCase: metrics,
					comparisons: comparePredictedObserved(selectedWorstCase, metrics, HELD_OUT_TOLERANCES)
						.comparisons,
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
