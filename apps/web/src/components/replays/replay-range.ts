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
 * Chunks per fetched range.
 *
 * Ranges are aligned to a fixed grid of this size, which is the single load-
 * bearing decision here: an unaligned range starting at the playhead would mint
 * a new atom-family key on every tick, so nothing would ever be served from
 * cache and scrubbing back would refetch. Aligned, the same stretch of the
 * recording always resolves to the same key.
 *
 * Must stay <= the server's `max_chunks_per_request` (40); the manifest echoes
 * the real cap so a mismatch is detectable rather than silent.
 */
export const RANGE_SIZE = 16

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

/** Snap a chunk sequence down to its grid slot. */
export const alignRangeStart = (chunkSeq: number) => Math.floor(chunkSeq / RANGE_SIZE) * RANGE_SIZE

/** The grid range containing `chunkSeq`. */
export const rangeContaining = (chunkSeq: number): ReplayRange => {
	const fromChunkSeq = alignRangeStart(chunkSeq)
	return { fromChunkSeq, toChunkSeq: fromChunkSeq + RANGE_SIZE - 1 }
}

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
export const initialRanges = (chunks: ReadonlyArray<ReplayChunkMeta>): ReadonlyArray<ReplayRange> => {
	if (chunks.length === 0) return []
	const seed = chunks.find((chunk) => chunk.is_checkpoint) ?? chunks[0]!
	return rangesCovering(chunks, seed.chunk_seq, INITIAL_WINDOW_BYTES)
}

/**
 * Grid ranges starting at `fromChunkSeq`, extended until `byteBudget` is met.
 *
 * Always returns at least one range, so a single chunk larger than the whole
 * budget still loads instead of stalling playback forever.
 */
export const rangesCovering = (
	chunks: ReadonlyArray<ReplayChunkMeta>,
	fromChunkSeq: number,
	byteBudget: number,
): ReadonlyArray<ReplayRange> => {
	const ranges: Array<ReplayRange> = []
	let bytes = 0
	let cursor = fromChunkSeq
	const lastSeq = chunks[chunks.length - 1]?.chunk_seq
	if (lastSeq === undefined) return []
	while (cursor <= lastSeq) {
		const range = rangeContaining(cursor)
		if (ranges.some((existing) => existing.fromChunkSeq === range.fromChunkSeq)) break
		ranges.push(range)
		for (const chunk of chunks) {
			if (chunk.chunk_seq < range.fromChunkSeq || chunk.chunk_seq > range.toChunkSeq) continue
			bytes += chunk.byte_size
		}
		if (bytes >= byteBudget) break
		cursor = range.toChunkSeq + 1
	}
	return ranges
}
