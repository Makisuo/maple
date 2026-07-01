import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
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
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointRoot, checkpointSnapshotDir, checkpointStatePath } from "../src/server/checkpoints"
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
	recommendationToTuning,
	writeCalibrationConfig,
	type CalibrationRecommendation,
	CANDIDATE_MATRIX,
} from "../src/server/archives/calibrate"
import {
	reconcileCalibration,
	writeCalibrationRecord,
	calibrationRecoveryPath,
	calibrationPinPurpose,
	derivedScratchSubdir,
	derivedSampleDir,
	directoryTreeBytes,
	preflightCalibrationFreeSpace,
} from "../src/server/archives/calibration-recovery"

const baseMetrics = (over: Partial<CandidateMetrics> = {}): CandidateMetrics => ({
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

describe("calibration config document — writeCalibrationConfig emits required fields", () => {
	it("writes environment, evidence, safetyMargin, recalibrationTriggers, and schemaFingerprint", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-cfg-"))
		try {
			const path = join(dir, "cfg.json")
			const rec: CalibrationRecommendation = {
				formatVersion: 1,
				selected: { candidate: CANDIDATE_MATRIX[0]!, worstCase: baseMetrics() },
				results: [okResult(CANDIDATE_MATRIX[0]!, "logs", baseMetrics())],
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
			strictEqual(doc.formatVersion, 1)
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

	it("re-running reconcile after cleanup is a no-op (idempotent)", async () => {
		await withRoots(async (roots) => {
			await reconcileCalibration(roots.archiveDir, roots)
			await reconcileCalibration(roots.archiveDir, roots)
			strictEqual(existsSync(calibrationRecoveryPath(roots.archiveDir)), false)
		})
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
