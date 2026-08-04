import { describe, expect, it } from "vitest"
import {
	INITIAL_WINDOW_BYTES,
	MAX_CHUNKS_PER_RANGE,
	type ReplayChunkMeta,
	type ReplayRange,
	checkpointAtOrBefore,
	chunkAtOffset,
	initialRanges,
	planRanges,
	rangeContaining,
	rangeKey,
	rangesCovering,
} from "./replay-range"

// ---------------------------------------------------------------------------
// Progressive-load decision logic.
//
// The loader hook itself is a thin shell over these decisions plus React state;
// what actually has to be right is *which ranges get fetched, in what order, and
// when a seek forces the engine to be rebuilt*. Those are exercised here against
// a simulated playthrough, because the browser pane this would otherwise be
// verified in never fires requestAnimationFrame (it renders hidden), so wall-clock
// playback can't be driven there.
// ---------------------------------------------------------------------------

const START_MS = 1_764_150_000_000
const CHUNK_MS = 5_000

const chunk = (seq: number, overrides: Partial<ReplayChunkMeta> = {}): ReplayChunkMeta => ({
	chunk_seq: seq,
	timestamp: new Date(START_MS + seq * CHUNK_MS).toISOString(),
	duration_ms: CHUNK_MS,
	event_count: 200,
	byte_size: 100_000,
	is_checkpoint: seq % 20 === 0,
	...overrides,
})

/** A 100-chunk session: ~8 minutes, 10 MB of payload, checkpoints every 20. */
const manifest = Array.from({ length: 100 }, (_, seq) => chunk(seq))
const plan = planRanges(manifest)

/**
 * Replay a playthrough the way the loader does: start from the initial window,
 * then whenever the playhead comes within `PREFETCH_AHEAD` of the loaded end,
 * pull the next grid range.
 */
const simulate = (chunks: ReadonlyArray<ReplayChunkMeta>, throughMs: number) => {
	const fetched: Array<ReplayRange> = [...initialRanges(chunks, planRanges(chunks))]
	const loadedThrough = () =>
		Math.max(...fetched.map((r) => r.toChunkSeq), -1)
	const lastSeq = chunks[chunks.length - 1]!.chunk_seq
	let playhead = 0
	while (playhead <= throughMs) {
		const loadedUntilMs = (loadedThrough() + 1) * CHUNK_MS
		if (playhead + 20_000 >= loadedUntilMs && loadedThrough() < lastSeq) {
			const next = rangeContaining(planRanges(chunks), loadedThrough() + 1)
			if (next && !fetched.some((r) => rangeKey(r) === rangeKey(next))) fetched.push(next)
		}
		playhead += 250 // sample far faster than chunk cadence, like the rAF tick
	}
	return fetched
}

describe("opening window", () => {
	it("starts on a couple of MB, not the whole session", () => {
		const ranges = initialRanges(manifest, plan)
		const bytes = ranges.length * MAX_CHUNKS_PER_RANGE * 100_000
		// The session is 10 MB. Before this change the player fetched all of it in
		// one response, which is what made long sessions fail.
		expect(bytes).toBeLessThan(4 * INITIAL_WINDOW_BYTES)
		expect(ranges.length).toBeLessThanOrEqual(2)
	})

	it("is independent of session length", () => {
		const long = Array.from({ length: 2000 }, (_, seq) => chunk(seq))
		expect(initialRanges(long, planRanges(long))).toEqual(initialRanges(manifest, plan))
	})
})

describe("playing forward", () => {
	it("pulls each range exactly once", () => {
		const fetched = simulate(manifest, 100 * CHUNK_MS)
		const keys = fetched.map(rangeKey)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it("stays ahead of the playhead without loading the whole session at once", () => {
		// A third of the way in, the tail must still be unfetched — otherwise this
		// is just the old all-at-once read wearing a different shape.
		const fetched = simulate(manifest, 33 * CHUNK_MS)
		const loadedThrough = Math.max(...fetched.map((r) => r.toChunkSeq))
		expect(loadedThrough).toBeGreaterThanOrEqual(33)
		expect(loadedThrough).toBeLessThan(99)
	})

	it("covers the session end to end by the time playback finishes", () => {
		const fetched = simulate(manifest, 100 * CHUNK_MS)
		const covered = new Set<number>()
		for (const r of fetched) {
			for (let s = r.fromChunkSeq; s <= r.toChunkSeq; s++) covered.add(s)
		}
		for (const c of manifest) expect(covered.has(c.chunk_seq)).toBe(true)
	})

	it("does not refetch a range the playhead scrubs back over", () => {
		const forward = simulate(manifest, 40 * CHUNK_MS).map(rangeKey)
		// Grid alignment means an earlier position maps to an already-fetched key.
		const back = rangeContaining(plan, chunkAtOffset(manifest, 12 * CHUNK_MS)!.chunk_seq)!
		expect(forward).toContain(rangeKey(back))
	})
})

describe("seeking", () => {
	const loadedAfterOpening = () => {
		const covered = new Set<number>()
		for (const r of initialRanges(manifest, plan)) {
			for (let s = r.fromChunkSeq; s <= r.toChunkSeq; s++) covered.add(s)
		}
		return covered
	}

	it("needs a rebuild when the target is outside the loaded span", () => {
		const covered = loadedAfterOpening()
		const target = chunkAtOffset(manifest, 90 * CHUNK_MS)!
		expect(covered.has(target.chunk_seq)).toBe(false)
	})

	it("rebuilds from a checkpoint, never from the bare target chunk", () => {
		// rrweb can only start from a full DOM snapshot; seeding on a mid-stream
		// chunk would replay mutations against a DOM that was never built.
		const target = chunkAtOffset(manifest, 90 * CHUNK_MS)!
		const anchor = checkpointAtOrBefore(manifest, target.chunk_seq)!
		expect(anchor.is_checkpoint).toBe(true)
		expect(anchor.chunk_seq).toBeLessThanOrEqual(target.chunk_seq)
		expect(anchor.chunk_seq).toBe(80)
	})

	it("loads a fresh window from the anchor, covering the target", () => {
		const target = chunkAtOffset(manifest, 90 * CHUNK_MS)!
		const anchor = checkpointAtOrBefore(manifest, target.chunk_seq)!
		const ranges = rangesCovering(manifest, plan, anchor.chunk_seq, INITIAL_WINDOW_BYTES)
		const covered = new Set<number>()
		for (const r of ranges) {
			for (let s = r.fromChunkSeq; s <= r.toChunkSeq; s++) covered.add(s)
		}
		expect(covered.has(anchor.chunk_seq)).toBe(true)
		expect(covered.has(target.chunk_seq)).toBe(true)
	})

	it("does not rebuild for a target already loaded", () => {
		const covered = loadedAfterOpening()
		const target = chunkAtOffset(manifest, 2 * CHUNK_MS)!
		expect(covered.has(target.chunk_seq)).toBe(true)
	})

	it("anchors on chunk 0 when the session has no checkpoint at all", () => {
		const noCheckpoints = manifest.map((c) => ({ ...c, is_checkpoint: false }))
		const target = chunkAtOffset(noCheckpoints, 90 * CHUNK_MS)!
		expect(checkpointAtOrBefore(noCheckpoints, target.chunk_seq)?.chunk_seq).toBe(0)
	})
})

describe("request volume", () => {
	it("replaces one unbounded request with a bounded request per range", () => {
		// The load-bearing property. Before: 1 request, entire payload, no ceiling.
		// After: N requests, each capped at RANGE_SIZE chunks and 8 MB.
		const fetched = simulate(manifest, 100 * CHUNK_MS)
		expect(fetched.length).toBe(plan.length)
		for (const r of fetched) {
			expect(r.toChunkSeq - r.fromChunkSeq + 1).toBeLessThanOrEqual(MAX_CHUNKS_PER_RANGE)
		}
	})
})
