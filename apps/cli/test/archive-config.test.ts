import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, throws } from "node:assert"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	ArchiveTuningRecord,
	DEFAULT_ARCHIVE_TUNING,
	resolveArchiveTuning,
	tuningRecord,
	loadTuningConfig,
	LEGACY_TUNING_CONFIG_FORMAT_VERSION,
	TUNING_CONFIG_FORMAT_VERSION,
} from "../src/server/archives/config"
import {
	CANDIDATE_MATRIX,
	comparePredictedObserved,
	HELD_OUT_TOLERANCES,
	RECALIBRATION_TRIGGERS,
} from "../src/server/archives/calibrate"
import { ARCHIVE_SIGNALS } from "../src/server/archives/signals"

const base = { archiveDir: "/tmp/archive", scratchRoot: "/tmp/scratch" }

describe("archive tuning config", () => {
	it("applies research-baseline defaults when only directories are supplied", () => {
		const tuning = resolveArchiveTuning(base)
		strictEqual(tuning.writerThreads, DEFAULT_ARCHIVE_TUNING.writerThreads)
		strictEqual(tuning.rowGroupRows, DEFAULT_ARCHIVE_TUNING.rowGroupRows)
		strictEqual(tuning.maxShardRows, DEFAULT_ARCHIVE_TUNING.maxShardRows)
		strictEqual(tuning.maxShardBytes, DEFAULT_ARCHIVE_TUNING.maxShardBytes)
		strictEqual(tuning.targetChunkBytes, DEFAULT_ARCHIVE_TUNING.targetChunkBytes)
		strictEqual(tuning.minFreeSpaceReserve, DEFAULT_ARCHIVE_TUNING.minFreeSpaceReserve)
	})

	it("overrides individual knobs while keeping the rest at defaults", () => {
		const tuning = resolveArchiveTuning({ ...base, writerThreads: 4, rowGroupRows: 50_000 })
		strictEqual(tuning.writerThreads, 4)
		strictEqual(tuning.rowGroupRows, 50_000)
		strictEqual(tuning.maxShardRows, DEFAULT_ARCHIVE_TUNING.maxShardRows)
	})

	it("records the effective values in a manifest-shaped tuning record", () => {
		const tuning = resolveArchiveTuning({ ...base, maxShardRows: 250_000 })
		const record: ArchiveTuningRecord = tuningRecord(tuning)
		deepStrictEqual(record, {
			writerThreads: 1,
			rowGroupRows: 10_000,
			maxShardRows: 250_000,
			maxShardBytes: 256 * 1024 * 1024,
			targetChunkBytes: 1024 * 1024 * 1024,
			minFreeSpaceReserve: 512 * 1024 * 1024,
		})
	})

	it("rejects a non-positive writer thread count", () => {
		throws(() => resolveArchiveTuning({ ...base, writerThreads: 0 }), /writerThreads/)
	})

	it("rejects a fractional row-group size", () => {
		throws(() => resolveArchiveTuning({ ...base, rowGroupRows: 10.5 }), /rowGroupRows/)
	})

	it("rejects a row group larger than the max shard", () => {
		throws(
			() => resolveArchiveTuning({ ...base, rowGroupRows: 1_000_000, maxShardRows: 500_000 }),
			/rowGroupRows must not exceed maxShardRows/,
		)
	})

	it("rejects a max shard byte budget too small for one row group", () => {
		throws(
			() => resolveArchiveTuning({ ...base, maxShardBytes: 1024, rowGroupRows: 10_000 }),
			/too small for rowGroupRows/,
		)
	})

	it("rejects a free-space reserve larger than the target chunk", () => {
		throws(
			() =>
				resolveArchiveTuning({
					...base,
					minFreeSpaceReserve: 2 * 1024 * 1024 * 1024,
					targetChunkBytes: 1024 * 1024 * 1024,
				}),
			/minFreeSpaceReserve must be smaller than targetChunkBytes/,
		)
	})

	it("rejects an implausibly large writer thread count", () => {
		throws(() => resolveArchiveTuning({ ...base, writerThreads: 100 }), /writerThreads/)
	})

	it("rejects a missing archive directory", () => {
		throws(() => resolveArchiveTuning({ scratchRoot: "/tmp/scratch" }), /archive directory/)
	})

	it("rejects a missing scratch root", () => {
		throws(() => resolveArchiveTuning({ archiveDir: "/tmp/archive" }), /scratch root/)
	})
})

describe("loadTuningConfig", () => {
	/** A minimal valid calibration config document for round-trip testing. */
	const validConfigDoc = (selectedCandidateIndex = 0, prependZeroLogicalAttempt = false) => {
		const candidate = CANDIDATE_MATRIX[selectedCandidateIndex]!
		const metrics = {
			logicalBytes: 1000,
			physicalBytes: 300,
			compressionRatio: 0.3,
			writeThroughputBytesPerSec: 200_000,
			peakTempDiskBytes: 500,
			peakRssBytes: 200,
			wallMs: 5,
			rowCount: 1000,
		}
		const heldOutMetrics = {
			...metrics,
			logicalBytes: 2000,
			physicalBytes: 600,
			wallMs: 10,
			rowCount: 2000,
		}
		const freeSpaceReserve = 500_000_000
		const effective = {
			...candidate,
			targetChunkBytes: Math.max(
				4 * candidate.maxShardBytes,
				freeSpaceReserve + candidate.maxShardBytes,
			),
			minFreeSpaceReserve: freeSpaceReserve,
		}
		const sampleRows = 1000
		const heldOutRows = 2 * sampleRows
		const trainingSample = (rowCount: number) => ({
			checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			checkpointManifestFingerprint: "checkpoint:fingerprint",
			rangeDate: "2026-07-01",
			role: "training" as const,
			startRow: 0,
			requestedRows: sampleRows,
			rowCount,
		})
		const heldOutSample = (rowCount: number) => ({
			checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			checkpointManifestFingerprint: "checkpoint:fingerprint",
			rangeDate: "2026-07-01",
			role: "held-out" as const,
			startRow: sampleRows,
			requestedRows: heldOutRows,
			rowCount,
		})
		const results = CANDIDATE_MATRIX.flatMap((matrixCandidate, candidateIndex) =>
			ARCHIVE_SIGNALS.map((signal) => ({
				candidate: matrixCandidate,
				signal: signal.name,
				metrics: { ...metrics, peakRssBytes: 200 + candidateIndex },
				ok: true,
				sample: trainingSample(1000),
			})),
		)
		const selectedWorstCase = { ...metrics, peakRssBytes: 200 + selectedCandidateIndex }
		const heldOutResults = ARCHIVE_SIGNALS.map((signal) => ({
			candidate,
			signal: signal.name,
			metrics: heldOutMetrics,
			ok: true,
			sample: heldOutSample(2000),
		}))
		// Per-signal like-for-like comparison: each signal pairs training metrics
		// with held-out metrics, scaled by that signal's own logical-byte ratio.
		const heldOutRatio = heldOutMetrics.logicalBytes / metrics.logicalBytes
		const signalComparisons = ARCHIVE_SIGNALS.map((signal) => {
			const comparison = comparePredictedObserved(
				selectedWorstCase,
				heldOutMetrics,
				HELD_OUT_TOLERANCES,
				{
					ratio: heldOutRatio,
					metrics: new Set(["wallMs", "physicalBytes"]),
				},
			)
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
			confidence: "high",
			checkpoint: {
				checkpointId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				manifestFingerprint: "checkpoint:fingerprint",
			},
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
			selected: {
				candidate,
				worstCase: selectedWorstCase,
			},
			heldOut: {
				results: heldOutResults,
				worstCase: heldOutMetrics,
				signalComparisons,
				passed: true,
				tolerances: HELD_OUT_TOLERANCES,
			},
			heldOutAttempts: [
				...(prependZeroLogicalAttempt
					? [
							{
								candidate: CANDIDATE_MATRIX[0]!,
								results: ARCHIVE_SIGNALS.map((signal) => ({
									candidate: CANDIDATE_MATRIX[0]!,
									signal: signal.name,
									metrics: {
										...heldOutMetrics,
										logicalBytes: 0,
										physicalBytes: 0,
										compressionRatio: 0,
										writeThroughputBytesPerSec: 0,
									},
									ok: true,
									sample: heldOutSample(2000),
								})),
								worstCase: null,
								signalComparisons: [],
								passed: false,
							},
						]
					: []),
				{
					candidate,
					results: heldOutResults,
					worstCase: heldOutMetrics,
					signalComparisons,
					passed: true,
				},
			],
			environment: {
				mapleVersion: "x",
				chdbVersion: "y",
				schemaFingerprint: "z",
				executionUser: "tester",
				platform: "darwin",
				arch: "arm64",
				cpuModel: "test-cpu",
				cpuCount: 8,
				totalMemoryBytes: 16_000_000_000,
				measurementTool: "/usr/bin/time",
				archiveVolume: { fsid: "dev:1", type: 17, archiveDir: "/tmp/archive" },
			},
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

	/**
	 * Model the actual Phase 3B shape: held-out RSS is lower than the selected
	 * training worst case. The evidence representation is what distinguishes a
	 * legacy v2 document (symmetric delta) from the repaired directional form.
	 */
	const makeHeldOutRssCheaper = (
		doc: ReturnType<typeof validConfigDoc>,
		policy: "directional" | "symmetric",
	): void => {
		for (const result of doc.heldOut.results) result.metrics.peakRssBytes = 100
		doc.heldOut.worstCase.peakRssBytes = 100
		const heldOutMetrics = doc.heldOut.results[0]!.metrics
		const ratio = heldOutMetrics.logicalBytes / doc.selected.worstCase.logicalBytes
		const signalComparisons = ARCHIVE_SIGNALS.map((signal) => {
			const comparison = comparePredictedObserved(
				doc.selected.worstCase,
				heldOutMetrics,
				HELD_OUT_TOLERANCES,
				{ ratio, metrics: new Set(["wallMs", "physicalBytes"]) },
			)
			return {
				signal: signal.name,
				scaleRatio: ratio,
				comparisons: comparison.comparisons.map((entry) => ({ ...entry })),
				passed: comparison.passed,
			}
		})
		if (policy === "symmetric") {
			for (const signal of signalComparisons) {
				const rss = signal.comparisons.find((entry) => entry.metric === "peakRssBytes")!
				// 100 observed versus 200 predicted: a valid v2 two-sided delta.
				rss.relativeDelta = 0.5
			}
		}
		doc.heldOut.signalComparisons = signalComparisons
		doc.heldOutAttempts[doc.heldOutAttempts.length - 1]!.signalComparisons = signalComparisons
	}

	const setConfigFormat = (doc: ReturnType<typeof validConfigDoc>, formatVersion: number): void => {
		;(doc as { formatVersion: number }).formatVersion = formatVersion
	}

	const cloneSignalComparisons = (doc: ReturnType<typeof validConfigDoc>) =>
		doc.heldOut.signalComparisons.map((signal) => ({
			...signal,
			comparisons: signal.comparisons.map((comparison) => ({ ...comparison })),
		}))

	it("round-trips an earlier non-positive-logical attempt before a later passing candidate", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-zero-logical-"))
		try {
			const path = join(dir, "config.json")
			writeFileSync(path, JSON.stringify(validConfigDoc(1, true)))
			const loaded = loadTuningConfig(path)
			strictEqual(loaded.document.selected.candidate.writerThreads, CANDIDATE_MATRIX[1]!.writerThreads)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("round-trips a valid config: loads effective overrides + SHA-256 identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			writeFileSync(path, JSON.stringify(doc))
			const { overrides, identity } = loadTuningConfig(path)
			strictEqual(overrides.writerThreads, 1)
			strictEqual(overrides.rowGroupRows, 10_000)
			strictEqual(identity.formatVersion, TUNING_CONFIG_FORMAT_VERSION)
			strictEqual(identity.configName, "cfg.json")
			strictEqual(identity.sha256.length, 64)
			// The SHA is stable for identical content.
			const again = loadTuningConfig(path)
			strictEqual(again.identity.sha256, identity.sha256)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("accepts the directional v3 evidence emitted after the calibration repair", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-directional-v3-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			makeHeldOutRssCheaper(doc, "directional")
			writeFileSync(path, JSON.stringify(doc))
			const loaded = loadTuningConfig(path)
			strictEqual(loaded.identity.formatVersion, TUNING_CONFIG_FORMAT_VERSION)
			strictEqual(loaded.identity.configName, "cfg.json")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("loads valid legacy v2 symmetric evidence and records its actual identity version", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-symmetric-v2-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			setConfigFormat(doc, LEGACY_TUNING_CONFIG_FORMAT_VERSION)
			makeHeldOutRssCheaper(doc, "symmetric")
			writeFileSync(path, JSON.stringify(doc))
			strictEqual(loadTuningConfig(path).identity.formatVersion, LEGACY_TUNING_CONFIG_FORMAT_VERSION)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("loads the deployed transitional v2 directional evidence and records version 2", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-directional-v2-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			setConfigFormat(doc, LEGACY_TUNING_CONFIG_FORMAT_VERSION)
			makeHeldOutRssCheaper(doc, "directional")
			writeFileSync(path, JSON.stringify(doc))
			strictEqual(loadTuningConfig(path).identity.formatVersion, LEGACY_TUNING_CONFIG_FORMAT_VERSION)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects a v3 document with legacy evidence and a v2 document that mixes policies", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-mixed-policy-"))
		try {
			const legacyInV3 = validConfigDoc()
			makeHeldOutRssCheaper(legacyInV3, "symmetric")
			const legacyInV3Path = join(dir, "legacy-in-v3.json")
			writeFileSync(legacyInV3Path, JSON.stringify(legacyInV3))
			throws(() => loadTuningConfig(legacyInV3Path), /signalComparisons.*recomputed/i)

			const mixedV2 = validConfigDoc()
			setConfigFormat(mixedV2, LEGACY_TUNING_CONFIG_FORMAT_VERSION)
			makeHeldOutRssCheaper(mixedV2, "directional")
			const legacyAttempt = cloneSignalComparisons(mixedV2)
			for (const signal of legacyAttempt) {
				signal.comparisons.find((entry) => entry.metric === "peakRssBytes")!.relativeDelta = 0.5
			}
			mixedV2.heldOutAttempts[0]!.signalComparisons = legacyAttempt
			const mixedV2Path = join(dir, "mixed-v2.json")
			writeFileSync(mixedV2Path, JSON.stringify(mixedV2))
			throws(() => loadTuningConfig(mixedV2Path), /signalComparisons.*recomputed|semantic evidence/i)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unknown top-level field (strict schema)", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = { ...validConfigDoc(), rogue: "evil" }
			writeFileSync(path, JSON.stringify(doc))
			throws(() => loadTuningConfig(path), /unknown calibration config field 'rogue'/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unknown effective field", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			;(doc.effective as typeof doc.effective & { bogus: number }).bogus = 1
			writeFileSync(path, JSON.stringify(doc))
			throws(() => loadTuningConfig(path), /unknown calibration config effective\.bogus/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects hostile semantic rewrites even when every field remains well typed", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-semantic-"))
		try {
			const cases: Array<{ name: string; mutate: (doc: ReturnType<typeof validConfigDoc>) => void }> = [
				{
					name: "forged-selected-worst-case",
					mutate: (doc) => {
						doc.selected.worstCase.peakRssBytes++
					},
				},
				{
					name: "missing-training-cell",
					mutate: (doc) => {
						doc.results.pop()
					},
				},
				{
					name: "forged-held-out-comparison",
					mutate: (doc) => {
						doc.heldOut.signalComparisons[0]!.comparisons[0]!.withinTolerance = false
					},
				},
				{
					name: "forged-effective-reserve",
					mutate: (doc) => {
						doc.effective.minFreeSpaceReserve++
					},
				},
				{
					name: "forged-derivation",
					mutate: (doc) => {
						doc.derivation.targetChunkBytes = "selected.maxShardBytes" as never
					},
				},
				{
					name: "wrong-checkpoint-shape",
					mutate: (doc) => {
						doc.checkpoint.manifestFingerprint = ""
					},
				},
				{
					name: "forged-training-scope-checkpoint",
					mutate: (doc) => {
						doc.results[0]!.sample!.checkpointId = "11111111-1111-4111-8111-111111111111"
					},
				},
				{
					name: "forged-training-scope-role",
					mutate: (doc) => {
						doc.results[0]!.sample!.role = "held-out"
					},
				},
				{
					name: "forged-held-out-scope-non-disjoint",
					mutate: (doc) => {
						doc.heldOut.results[0]!.sample!.startRow = 0
					},
				},
				{
					name: "forged-scope-rowcount-mismatch",
					mutate: (doc) => {
						doc.results[0]!.sample!.rowCount = 1
					},
				},
				{
					name: "forged-sample-policy-multiplier",
					mutate: (doc) => {
						doc.samplePolicy.heldOutMultiplier = 1
						doc.samplePolicy.heldOutRows = 1000
						doc.samplePolicy.heldOutWindow = "[1000, 2000)"
					},
				},
				{
					name: "forged-scale-ratio",
					mutate: (doc) => {
						doc.heldOut.signalComparisons[0]!.scaleRatio = 0.5
					},
				},
				{
					name: "short-observed-held-out-window",
					mutate: (doc) => {
						for (const result of doc.heldOut.results) {
							result.metrics.rowCount = doc.budget.sampleRows
							result.sample.rowCount = doc.budget.sampleRows
						}
					},
				},
				{
					name: "forged-canonical-tolerances-with-recomputed-comparisons",
					mutate: (doc) => {
						// The original 1000x hostile reproduction: redefine tolerances
						// and recompute every per-signal comparison with them, so the
						// document is internally consistent yet the loader must reject
						// because the tolerance policy is not canonical.
						const forged = {
							peakRssBytes: 10_000,
							wallMs: 10_000,
							writeThroughputBytesPerSec: 10_000,
							compressionRatio: 10_000,
							physicalBytes: 10_000,
							peakTempDiskBytes: 10_000,
						}
						doc.heldOut.tolerances = forged as typeof doc.heldOut.tolerances
						const trainingMetrics = doc.results[0]!.metrics!
						const heldOutMetrics = doc.heldOut.results[0]!.metrics!
						const ratio = heldOutMetrics.logicalBytes / trainingMetrics.logicalBytes
						const recomputed = ARCHIVE_SIGNALS.map((signal) => {
							const comparison = comparePredictedObserved(
								trainingMetrics,
								heldOutMetrics,
								forged,
								{ ratio, metrics: new Set(["wallMs", "physicalBytes"]) },
							)
							return {
								signal: signal.name,
								scaleRatio: ratio,
								comparisons: comparison.comparisons,
								passed: comparison.passed,
							}
						})
						doc.heldOut.signalComparisons = recomputed
						doc.heldOutAttempts[0]!.signalComparisons = recomputed
					},
				},
			]
			for (const testCase of cases) {
				const doc = validConfigDoc()
				testCase.mutate(doc)
				const path = join(dir, `${testCase.name}.json`)
				writeFileSync(path, JSON.stringify(doc))
				throws(() => loadTuningConfig(path), /invalid|missing|recomputed|derivation/i)
			}
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects malformed nested selected/results/metrics evidence and non-ISO timestamps", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const cases: Array<{ name: string; mutate: (doc: ReturnType<typeof validConfigDoc>) => void }> = [
				{
					name: "missing-worst-case",
					mutate: (doc) => {
						doc.selected = { candidate: doc.selected.candidate } as typeof doc.selected
					},
				},
				{
					name: "invalid-result-metrics",
					mutate: (doc) => {
						doc.results[0]!.metrics = "garbage" as never
						doc.results[0]!.ok = true
					},
				},
				{
					name: "invalid-result-candidate",
					mutate: (doc) => {
						doc.results[0]!.candidate = null as never
					},
				},
				{
					name: "non-iso-time",
					mutate: (doc) => {
						doc.measuredAt = "not-an-ISO-timestamp"
					},
				},
			]
			for (const testCase of cases) {
				const doc = validConfigDoc()
				testCase.mutate(doc)
				const path = join(dir, `${testCase.name}.json`)
				writeFileSync(path, JSON.stringify(doc))
				throws(() => loadTuningConfig(path), /invalid|missing/i)
			}
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unsupported formatVersion", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "cfg.json")
			writeFileSync(path, JSON.stringify({ ...validConfigDoc(), formatVersion: 99 }))
			throws(() => loadTuningConfig(path), /unsupported calibration config formatVersion/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("refuses a non-regular file (symlink) — one-fd regular-file check", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const real = join(dir, "real.json")
			const link = join(dir, "link.json")
			writeFileSync(real, JSON.stringify(validConfigDoc()))
			symlinkSync(real, link)
			throws(() => loadTuningConfig(link), /regular file/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unsafe config name (path-like basename)", () => {
		// A basename with a slash is not possible as a single path segment; test a
		// name that fails the safe-name regex (e.g. contains a space).
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "bad name.json")
			writeFileSync(path, JSON.stringify(validConfigDoc()))
			throws(() => loadTuningConfig(path), /unsafe calibration config name/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
