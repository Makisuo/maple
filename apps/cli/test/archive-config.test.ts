import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual, throws } from "node:assert"
import {
	ArchiveTuningRecord,
	DEFAULT_ARCHIVE_TUNING,
	resolveArchiveTuning,
	tuningRecord,
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
