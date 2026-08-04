import { describe, expect, it } from "vitest"
import {
	INITIAL_WINDOW_BYTES,
	MAX_BYTES_PER_RANGE,
	MAX_CHUNKS_PER_RANGE,
	type ReplayChunkMeta,
	checkpointAtOrBefore,
	chunkAtOffset,
	chunkStartMs,
	initialRanges,
	planRanges,
	manifestDurationMs,
	rangeContaining,
	rangesCovering,
	replayRangeInput,
} from "./replay-range"

const START_MS = 1_764_150_000_000

/** Chunks every 5s, ~100 KB each — the SDK's steady-state flush cadence. */
const chunk = (seq: number, overrides: Partial<ReplayChunkMeta> = {}): ReplayChunkMeta => ({
	chunk_seq: seq,
	timestamp: new Date(START_MS + seq * 5_000).toISOString(),
	duration_ms: 5_000,
	event_count: 200,
	byte_size: 100_000,
	is_checkpoint: seq === 0,
	...overrides,
})

const manifest = (count: number, overrides: (seq: number) => Partial<ReplayChunkMeta> = () => ({})) =>
	Array.from({ length: count }, (_, seq) => chunk(seq, overrides(seq)))

describe("range planning", () => {
	it("keeps every range inside the server's byte budget", () => {
		// Real sessions carry ~838 KB chunks. A fixed 16-chunk range of those is
		// ~13 MB, which the server refuses with 413 — and the client has no way to
		// recover a range it cannot request.
		const big = manifest(64, () => ({ byte_size: 838_026 }))
		for (const range of planRanges(big)) {
			const bytes = big
				.filter((c) => c.chunk_seq >= range.fromChunkSeq && c.chunk_seq <= range.toChunkSeq)
				.reduce((sum, c) => sum + c.byte_size, 0)
			expect(bytes).toBeLessThanOrEqual(MAX_BYTES_PER_RANGE)
		}
	})

	it("still caps chunk count when chunks are small", () => {
		for (const range of planRanges(manifest(64))) {
			expect(range.toChunkSeq - range.fromChunkSeq + 1).toBeLessThanOrEqual(MAX_CHUNKS_PER_RANGE)
		}
	})

	it("covers every chunk exactly once", () => {
		const chunks = manifest(50, (seq) => ({ byte_size: seq % 7 === 0 ? 900_000 : 100_000 }))
		const seen: number[] = []
		for (const r of planRanges(chunks)) {
			for (let s = r.fromChunkSeq; s <= r.toChunkSeq; s++) seen.push(s)
		}
		expect(seen).toEqual(chunks.map((c) => c.chunk_seq))
	})

	it("keeps boundaries stable as a live session appends chunks", () => {
		// The cache-correctness property: the atom family keys on the range, so a
		// boundary that shifted when new chunks arrived would orphan everything
		// already fetched and refetch the session from the start.
		const grown = manifest(60)
		const early = planRanges(grown.slice(0, 40))
		const later = planRanges(grown)
		expect(later.slice(0, early.length - 1)).toEqual(early.slice(0, early.length - 1))
	})

	it("resolves any chunk in a range to that same range", () => {
		const chunks = manifest(64)
		const p = planRanges(chunks)
		const first = p[0]!
		for (const seq of [first.fromChunkSeq, first.toChunkSeq]) {
			expect(rangeContaining(p, seq)).toEqual(first)
		}
	})

	it("produces one identical atom key for every position inside a range", () => {
		const chunks = manifest(64)
		const p = planRanges(chunks)
		const window = { windowStart: "2026-08-04 10:00:00", windowEnd: "2026-08-04 11:00:00" }
		const keys = new Set(
			[p[0]!.fromChunkSeq, p[0]!.fromChunkSeq + 1, p[0]!.toChunkSeq].map((seq) =>
				JSON.stringify(replayRangeInput("sess_1", window, rangeContaining(p, seq)!)),
			),
		)
		expect(keys.size).toBe(1)
	})

	it("returns nothing for a chunk past the end of the plan", () => {
		expect(rangeContaining(planRanges(manifest(4)), 999)).toBeUndefined()
	})

	it("keeps ranges within the server's per-request chunk cap", () => {
		expect(MAX_CHUNKS_PER_RANGE).toBeLessThanOrEqual(40)
	})
})

describe("initialRanges", () => {
	it("stops on the byte budget, not a chunk count", () => {
		// 100 KB chunks: ~20 chunks fit in the 2 MB budget, so more than one
		// 16-chunk range.
		const ranges = initialRanges(manifest(64), planRanges(manifest(64)))
		const bytes = ranges.length * MAX_CHUNKS_PER_RANGE * 100_000
		expect(bytes).toBeGreaterThanOrEqual(INITIAL_WINDOW_BYTES)
		expect(ranges.length).toBeLessThanOrEqual(2)
	})

	it("loads exactly one range when chunks are large", () => {
		// A 4 MB chunk (full snapshot of a dense DOM) blows the budget alone. The
		// count-based version of this would have pulled 8 of them — 32 MB.
		const ranges = initialRanges(manifest(64, () => ({ byte_size: 4_000_000 })), planRanges(manifest(64, () => ({ byte_size: 4_000_000 }))))
		expect(ranges).toHaveLength(1)
	})

	it("seeds from the first checkpoint, not chunk 0", () => {
		// Chunks before the first snapshot are mutations against a DOM that was
		// never built — loading them buys a blank screen.
		const chunks = manifest(64, (seq) => ({ is_checkpoint: seq === 20 }))
		expect(initialRanges(chunks, planRanges(chunks))[0]).toEqual(rangeContaining(planRanges(chunks), 20))
	})

	it("returns nothing for an empty manifest", () => {
		expect(initialRanges([], planRanges([]))).toEqual([])
	})

	it("never runs past the end of a short session", () => {
		// 3 chunks = 300 KB, well under the budget: it must stop at the manifest
		// end rather than looping toward the budget forever.
		expect(initialRanges(manifest(3), planRanges(manifest(3)))).toEqual([rangeContaining(planRanges(manifest(3)), 0)])
	})
})

describe("rangesCovering", () => {
	it("always yields at least one range, even past the budget", () => {
		expect(rangesCovering(manifest(4), planRanges(manifest(4)), 0, 0)).toHaveLength(1)
	})

	it("returns nothing when there is nothing to cover", () => {
		expect(rangesCovering([], planRanges([]), 0, INITIAL_WINDOW_BYTES)).toEqual([])
	})
})

describe("checkpointAtOrBefore", () => {
	it("finds the nearest preceding snapshot — the only valid seek anchor", () => {
		const chunks = manifest(64, (seq) => ({ is_checkpoint: seq % 20 === 0 }))
		expect(checkpointAtOrBefore(chunks, 45)?.chunk_seq).toBe(40)
	})

	it("never returns a checkpoint after the target", () => {
		const chunks = manifest(64, (seq) => ({ is_checkpoint: seq % 20 === 0 }))
		expect(checkpointAtOrBefore(chunks, 39)?.chunk_seq).toBe(20)
	})

	it("falls back to the first chunk when no checkpoint precedes the target", () => {
		// Sessions whose opening snapshot was dropped by the SDK's over-cap buffer
		// guard have no checkpoint at all — seeking must still do something.
		const chunks = manifest(8, () => ({ is_checkpoint: false }))
		expect(checkpointAtOrBefore(chunks, 5)?.chunk_seq).toBe(0)
	})
})

describe("playback clock", () => {
	it("positions a chunk by its ingest timestamp", () => {
		expect(chunkStartMs(chunk(4))).toBe(START_MS + 20_000)
	})

	it("derives total duration from the manifest, not from loaded events", () => {
		// getMetaData() reads live context, so a player-derived total would grow
		// as chunks stream in and the scrubber would stretch mid-playback.
		expect(manifestDurationMs(manifest(10))).toBe(9 * 5_000 + 5_000)
	})

	it("reports zero duration for an empty manifest", () => {
		expect(manifestDurationMs([])).toBe(0)
	})
})

// Every session in the 30-day retention predates this change, and none of them
// carry anything the old read path didn't already write. These pin that the new
// planning logic works off columns that have always been populated — so an
// existing recording plays exactly like one captured after the change.
describe("sessions recorded before this change", () => {
	it("needs nothing beyond chunk_seq, timestamp, duration, size and checkpoint", () => {
		// The full input contract. If a future field creeps in here, older
		// sessions start failing to plan.
		expect(Object.keys(chunk(0)).sort()).toEqual([
			"byte_size",
			"chunk_seq",
			"duration_ms",
			"event_count",
			"is_checkpoint",
			"timestamp",
		])
	})

	it("plays a session that never produced a checkpoint at all", () => {
		// The SDK's over-cap buffer guard drops the batch containing the opening
		// snapshot; such sessions have no checkpoint anywhere. Playback must still
		// pick an anchor rather than refusing.
		const chunks = manifest(8, () => ({ is_checkpoint: false }))
		expect(checkpointAtOrBefore(chunks, 5)?.chunk_seq).toBe(0)
		expect(initialRanges(chunks, planRanges(chunks))[0]).toEqual(rangeContaining(planRanges(chunks), 0))
	})

	it("handles a single-chunk session", () => {
		const chunks = manifest(1)
		expect(initialRanges(chunks, planRanges(chunks))).toEqual([{ fromChunkSeq: 0, toChunkSeq: 0 }])
		expect(chunkAtOffset(chunks, 0)?.chunk_seq).toBe(0)
		expect(manifestDurationMs(chunks)).toBe(5_000)
	})

	it("handles a session whose chunk_seq does not start at 0", () => {
		// nextChunkSeq() is monotonic across reloads and persisted on the session
		// record, so a session resumed after a refresh starts mid-sequence.
		const chunks = manifest(20).map((c) => ({ ...c, chunk_seq: c.chunk_seq + 137 }))
		expect(initialRanges(chunks, planRanges(chunks))[0]).toEqual(rangeContaining(planRanges(chunks), 137))
		expect(checkpointAtOrBefore(chunks, 150)?.chunk_seq).toBe(137)
	})
})

describe("chunkAtOffset", () => {
	it("resolves a playback offset to its covering chunk", () => {
		expect(chunkAtOffset(manifest(10), 22_000)?.chunk_seq).toBe(4)
	})

	it("clamps a target before the recording to the first chunk", () => {
		expect(chunkAtOffset(manifest(10), -5_000)?.chunk_seq).toBe(0)
	})

	it("clamps a target past the end to the last chunk", () => {
		expect(chunkAtOffset(manifest(10), 10_000_000)?.chunk_seq).toBe(9)
	})

	it("returns nothing for an empty manifest", () => {
		expect(chunkAtOffset([], 0)).toBeUndefined()
	})
})
