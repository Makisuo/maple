import type { ReplayPartitionWindow } from "./replay-format"

/**
 * Chunk-range planning for progressive replay playback.
 *
 * A session's rrweb payload can run to hundreds of megabytes, so the player
 * fetches it a range at a time rather than all at once. These helpers decide
 * *which* ranges — and, just as importantly, keep those ranges stable so the
 * atom cache can actually hit.
 */

/**
 * Upper bound on chunks per fetched range.
 *
 * A range can be shorter — `planRanges` closes one early when its payload would
 * exceed the server's byte budget. Must stay <= the server's
 * `max_chunks_per_request` (40); the manifest echoes the real cap so a mismatch
 * is detectable rather than silent.
 */
export const MAX_CHUNKS_PER_RANGE = 16

/**
 * Fallback byte budget for one range, used before the manifest reports the
 * server's own `max_bytes_per_request`. Matches the server default.
 */
export const MAX_BYTES_PER_RANGE = 8_000_000

/**
 * Bytes to load before starting playback.
 *
 * Byte-driven, not count-driven: a chunk flushes at ~100 KB but may be up to
 * 4 MB (a full snapshot of a dense DOM), so "8 chunks" can mean 800 KB or 32 MB.
 */
export const INITIAL_WINDOW_BYTES = 2_000_000

/** Playback time to keep buffered ahead of the playhead. */
export const PREFETCH_AHEAD_MS = 20_000

/** One chunk's manifest entry — the subset of the v2 manifest the player needs. */
export interface ReplayChunkMeta {
	readonly chunk_seq: number
	readonly timestamp: string
	readonly duration_ms: number
	readonly event_count: number
	readonly byte_size: number
	readonly is_checkpoint: boolean
}

export interface ReplayRange {
	readonly fromChunkSeq: number
	readonly toChunkSeq: number
}

/**
 * Cut the session into the ranges playback will fetch.
 *
 * Two properties matter, and a fixed-size grid only delivers one of them:
 *
 * 1. **Every range fits the server's byte budget.** Chunk sizes vary by more
 *    than an order of magnitude — a flush is ~100 KB but a full DOM snapshot
 *    runs to several hundred KB or more, and real sessions carry 838 KB chunks.
 *    A fixed 16-chunk slot of those is ~13 MB, well past the 8 MB ceiling, so
 *    the request comes back 413 and that stretch of the recording is unplayable.
 * 2. **Boundaries are stable**, because the atom family keys on the range. A
 *    range recomputed from the playhead would mint a new key every tick and
 *    nothing would ever be cached.
 *
 * Walking greedily from the first chunk gives both: the cut points depend only
 * on chunks at or before them, so a live session appending chunks extends the
 * plan without moving any boundary already in it.
 *
 * A single chunk always gets a range even if it alone exceeds the budget — the
 * SDK caps a chunk at 4 MB, so under an 8 MB budget that can't happen, but
 * emitting nothing would stall playback rather than fail it.
 */
export const planRanges = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	maxBytes: number = MAX_BYTES_PER_RANGE,
	maxChunks: number = MAX_CHUNKS_PER_RANGE,
): ReadonlyArray<ReplayRange> => {
	const ranges: Array<ReplayRange> = []
	let start: number | undefined
	let end = 0
	let bytes = 0
	let count = 0
	for (const chunk of chunks) {
		if (start !== undefined && (bytes + chunk.byte_size > maxBytes || count >= maxChunks)) {
			ranges.push({ fromChunkSeq: start, toChunkSeq: end })
			start = undefined
			bytes = 0
			count = 0
		}
		if (start === undefined) start = chunk.chunk_seq
		end = chunk.chunk_seq
		bytes += chunk.byte_size
		count++
	}
	if (start !== undefined) ranges.push({ fromChunkSeq: start, toChunkSeq: end })
	return ranges
}

/** The planned range containing `chunkSeq`, or undefined if it is past the end. */
export const rangeContaining = (
	plan: ReadonlyArray<ReplayRange>,
	chunkSeq: number,
): ReplayRange | undefined =>
	plan.find((range) => chunkSeq >= range.fromChunkSeq && chunkSeq <= range.toChunkSeq)

/** Stable key for a range — must match `replayRangeInput`'s identity exactly. */
export const rangeKey = (range: ReplayRange) => `${range.fromChunkSeq}:${range.toChunkSeq}`

/**
 * Build the atom-family input for a range.
 *
 * `makeQueryAtomFamily` keys on `JSON.stringify(input)`, so key identity is
 * property-ORDER sensitive. Every call site goes through this one builder so an
 * innocently reordered object literal can't silently split the cache.
 */
export const replayRangeInput = (
	sessionId: string,
	window: ReplayPartitionWindow | undefined,
	range: ReplayRange,
) => ({
	sessionId,
	...window,
	fromChunkSeq: range.fromChunkSeq,
	toChunkSeq: range.toChunkSeq,
})

/**
 * Where a chunk sits on the playback timeline.
 *
 * `timestamp` is the ingest gateway's receipt time, so it trails the recording's
 * own clock by the upload latency — well inside one chunk's duration. That makes
 * it precise enough to resolve a seek to the right *chunk*, which is all this is
 * used for; the exact offset within that chunk comes from its rrweb events once
 * loaded.
 *
 * Deliberately not a stored first-event timestamp: adding one meant a new
 * warehouse column, and a column the deployed cluster doesn't have yet fails
 * every read with schema drift (and every insert), so it would have broken all
 * replay until an out-of-band migration landed. Not worth sub-second precision
 * on a chunk picker.
 */
export const chunkStartMs = (chunk: ReplayChunkMeta): number => Date.parse(chunk.timestamp)

/** Epoch-ms the recording starts at, or 0 for an empty manifest. */
export const manifestStartMs = (chunks: ReadonlyArray<ReplayChunkMeta>): number => {
	const first = chunks[0]
	return first === undefined ? 0 : chunkStartMs(first)
}

/**
 * Total playable length.
 *
 * Derived from the manifest rather than the player's `getMetaData()`, which
 * reads live context and would therefore *grow* as chunks stream in — the
 * scrubber would stretch while you watched.
 */
export const manifestDurationMs = (chunks: ReadonlyArray<ReplayChunkMeta>): number => {
	const last = chunks[chunks.length - 1]
	if (last === undefined) return 0
	return Math.max(0, chunkStartMs(last) + last.duration_ms - manifestStartMs(chunks))
}

/**
 * The chunk covering `offsetMs` into the recording.
 *
 * Returns the last chunk that starts at or before the target; falls back to the
 * first chunk for a target before the recording begins.
 */
export const chunkAtOffset = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	offsetMs: number,
): ReplayChunkMeta | undefined => {
	if (chunks.length === 0) return undefined
	const targetMs = manifestStartMs(chunks) + offsetMs
	let match = chunks[0]
	for (const chunk of chunks) {
		if (chunkStartMs(chunk) > targetMs) break
		match = chunk
	}
	return match
}

/**
 * The seek anchor for a target chunk: the nearest checkpoint at or before it.
 *
 * rrweb can only start from a full DOM snapshot, so seeking into an unloaded
 * region means loading from here — not from the target chunk, which on its own
 * is a stream of mutations against a DOM that was never built.
 *
 * Falls back to the first chunk when no checkpoint precedes the target, which
 * happens on sessions whose opening snapshot was dropped (see the over-cap
 * buffer path in the SDK recorder).
 */
export const checkpointAtOrBefore = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	chunkSeq: number,
): ReplayChunkMeta | undefined => {
	let anchor: ReplayChunkMeta | undefined
	for (const chunk of chunks) {
		if (chunk.chunk_seq > chunkSeq) break
		if (chunk.is_checkpoint) anchor = chunk
	}
	return anchor ?? chunks[0]
}

/**
 * Ranges to load for the opening frame: from the first checkpoint until the
 * byte budget is met.
 *
 * Starting at the first checkpoint rather than chunk 0 matters for sessions
 * whose first chunks are pre-snapshot noise — without a snapshot there is
 * nothing to render, so those bytes would buy a blank screen.
 */
export const initialRanges = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	plan: ReadonlyArray<ReplayRange>,
): ReadonlyArray<ReplayRange> => {
	if (chunks.length === 0) return []
	const seed = chunks.find((chunk) => chunk.is_checkpoint) ?? chunks[0]!
	return rangesCovering(chunks, plan, seed.chunk_seq, INITIAL_WINDOW_BYTES)
}

/**
 * Planned ranges from the one containing `fromChunkSeq`, extended until
 * `byteBudget` is met.
 *
 * Always returns at least one range, so a chunk larger than the whole budget
 * still loads instead of stalling playback forever.
 */
export const rangesCovering = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	plan: ReadonlyArray<ReplayRange>,
	fromChunkSeq: number,
	byteBudget: number,
): ReadonlyArray<ReplayRange> => {
	const startIndex = plan.findIndex(
		(range) => fromChunkSeq >= range.fromChunkSeq && fromChunkSeq <= range.toChunkSeq,
	)
	if (startIndex < 0) return []
	const bytesIn = (range: ReplayRange) =>
		chunks.reduce(
			(sum, chunk) =>
				chunk.chunk_seq >= range.fromChunkSeq && chunk.chunk_seq <= range.toChunkSeq
					? sum + chunk.byte_size
					: sum,
			0,
		)
	const ranges: Array<ReplayRange> = []
	let bytes = 0
	for (let i = startIndex; i < plan.length; i++) {
		const range = plan[i]!
		ranges.push(range)
		bytes += bytesIn(range)
		if (bytes >= byteBudget) break
	}
	return ranges
}
