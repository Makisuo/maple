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
	TUNING_CONFIG_FORMAT_VERSION,
} from "../src/server/archives/config"

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
	const validConfigDoc = (
		effective = {
			writerThreads: 2,
			rowGroupRows: 20_000,
			maxShardRows: 500_000,
			maxShardBytes: 256 * 1024 * 1024,
			targetChunkBytes: 1024 * 1024 * 1024,
			minFreeSpaceReserve: 512 * 1024 * 1024,
		},
	) => ({
		formatVersion: TUNING_CONFIG_FORMAT_VERSION,
		measuredAt: "2026-07-01T00:00:00.000Z",
		confidence: "high",
		budget: {
			memoryBudget: 1e9,
			timeBudget: 60000,
			sampleRows: 1000,
			maxCandidateWallMs: 30000,
			minThroughputBytesPerSec: 0,
			maxTempDiskBytes: 2e9,
			freeSpaceReserve: 5e8,
			safetyMargin: 1.1,
		},
		selected: {
			candidate: {
				writerThreads: effective.writerThreads,
				rowGroupRows: effective.rowGroupRows,
				maxShardRows: effective.maxShardRows,
				maxShardBytes: effective.maxShardBytes,
			},
			worstCase: {
				logicalBytes: 1000,
				physicalBytes: 300,
				compressionRatio: 0.3,
				writeThroughputBytesPerSec: 100,
				peakTempDiskBytes: 500,
				peakRssBytes: 200,
				wallMs: 5,
				rowCount: 10,
			},
		},
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
		safetyMargin: 1.1,
		recalibrationTriggers: ["Maple version change"],
		results: [
			{
				candidate: {
					writerThreads: effective.writerThreads,
					rowGroupRows: effective.rowGroupRows,
					maxShardRows: effective.maxShardRows,
					maxShardBytes: effective.maxShardBytes,
				},
				signal: "logs",
				metrics: null,
				ok: false,
				error: "x",
			},
		],
		note: "test",
	})

	it("round-trips a valid config: loads effective overrides + SHA-256 identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-loadcfg-"))
		try {
			const path = join(dir, "cfg.json")
			const doc = validConfigDoc()
			writeFileSync(path, JSON.stringify(doc))
			const { overrides, identity } = loadTuningConfig(path)
			strictEqual(overrides.writerThreads, 2)
			strictEqual(overrides.rowGroupRows, 20_000)
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
			const effective = { ...validConfigDoc().effective, bogus: 1 }
			writeFileSync(path, JSON.stringify(validConfigDoc(effective)))
			throws(() => loadTuningConfig(path), /unknown calibration config effective field 'bogus'/)
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
