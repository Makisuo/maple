import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getReplayEventsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { normalizeEvents } from "./replay-events"
import type { ReplayPartitionWindow } from "./replay-format"
import {
	INITIAL_WINDOW_BYTES,
	MAX_BYTES_PER_RANGE,
	MAX_CHUNKS_PER_RANGE,
	PREFETCH_AHEAD_MS,
	type ReplayChunkMeta,
	type ReplayRange,
	chunkAtOffset,
	chunkStartMs,
	checkpointAtOrBefore,
	initialRanges,
	planRanges,
	manifestStartMs,
	rangeContaining,
	rangeKey,
	rangesCovering,
	replayRangeInput,
} from "./replay-range"

// ---------------------------------------------------------------------------
// Progressive chunk loading
//
// The player used to fetch a session's entire rrweb payload before rendering a
// frame. Ingest accepts up to 1 GiB per session and the p99 is ~594 MB, so on a
// long session that read died in the Worker and surfaced as a 503 blaming the
// database. Now: seed from a checkpoint, play, and pull the rest as it's needed.
//
// Ranges load one at a time. Sequential is not a limitation here — playback
// consumes chunks in order, so a second in-flight range would only ever be the
// one after the range already being fetched. One subscription also keeps this a
// plain hook instead of an imperative registry subscription per range.
// ---------------------------------------------------------------------------

/** What the player needs to know about loading, beyond the events themselves. */
export type ReplayBufferState = "idle" | "buffering" | "seeking"

interface LoadedRange {
	readonly key: string
	readonly range: ReplayRange
	readonly events: ReadonlyArray<unknown>
	/** Highest chunk_seq actually returned — the real end of loaded playback. */
	readonly lastChunkSeq: number
}

interface ChunkLoaderArgs {
	readonly sessionId: string
	readonly window: ReplayPartitionWindow | undefined
	readonly chunks: ReadonlyArray<ReplayChunkMeta>
	/** False while the manifest is still loading, or for the preview route. */
	readonly enabled: boolean
}

export interface ChunkLoaderState {
	/**
	 * Events the engine is constructed from. Changes only when playback needs a
	 * different anchor (first load, or a seek into an unloaded region), so a
	 * prefetch arriving mid-playback never tears the player down.
	 */
	readonly seedEvents: ReadonlyArray<unknown>
	/** Events loaded after the seed, in arrival order, for incremental feeding. */
	readonly trailingEvents: ReadonlyArray<unknown>
	readonly bufferState: ReplayBufferState
	readonly loadError: unknown
	/** Playback offset (ms from recording start) the engine should resume at. */
	readonly seekTargetMs: number | null
	/** Ask for a playback offset; rebuilds from a checkpoint if it isn't loaded. */
	readonly requestSeek: (offsetMs: number) => boolean
	/** Report the playhead so the loader can stay ahead of it. */
	readonly reportProgress: (offsetMs: number) => void
}

const EMPTY: ReadonlyArray<unknown> = []

/** Parse one range response into a flat, normalized rrweb event array. */
const decodeRange = (chunks: ReadonlyArray<{ chunk_seq: number; events: string }>): unknown[] => {
	const ordered = [...chunks].sort((a, b) => a.chunk_seq - b.chunk_seq)
	const all: unknown[] = []
	for (const chunk of ordered) {
		try {
			const parsed: unknown = JSON.parse(chunk.events)
			if (Array.isArray(parsed)) all.push(...parsed)
		} catch {
			// Skip a malformed chunk rather than failing the whole replay.
		}
	}
	// Normalized per range, not across the session: chunks can upload out of
	// order, and this is what makes each range independently well-formed.
	return normalizeEvents(all)
}

export function useReplayChunkLoader({
	sessionId,
	window,
	chunks,
	enabled,
}: ChunkLoaderArgs): ChunkLoaderState {
	// Ranges belonging to the current seed, in load order. Reset on a rebuild.
	const [loaded, setLoaded] = React.useState<ReadonlyArray<LoadedRange>>([])
	// How many of `loaded` make up the seed. The rest are fed incrementally.
	const [seedCount, setSeedCount] = React.useState(0)
	const [queue, setQueue] = React.useState<ReadonlyArray<ReplayRange>>([])
	const [seekTargetMs, setSeekTargetMs] = React.useState<number | null>(null)
	const [isSeeking, setIsSeeking] = React.useState(false)
	const playheadRef = React.useRef(0)

	const startMs = React.useMemo(() => manifestStartMs(chunks), [chunks])
	// Where the session gets cut into fetchable ranges. Derived from the manifest
	// so no range can exceed the server's byte ceiling — chunk sizes vary by more
	// than an order of magnitude, and a fixed chunk count would 413 on a session
	// whose snapshots are large.
	const plan = React.useMemo(() => planRanges(chunks, MAX_BYTES_PER_RANGE, MAX_CHUNKS_PER_RANGE), [chunks])

	// Plan the opening window once the manifest lands — and only once.
	//
	// A live session's manifest grows on every refetch, so re-planning whenever
	// `chunks` changes identity would discard the seed and rebuild the player
	// every few seconds. Growth is picked up by `enqueueNext` instead; a genuinely
	// different session is what warrants starting over.
	const plannedForRef = React.useRef<string | null>(null)
	React.useEffect(() => {
		if (!enabled || chunks.length === 0) return
		if (plannedForRef.current === sessionId) return
		plannedForRef.current = sessionId
		setLoaded([])
		setSeedCount(0)
		setIsSeeking(false)
		setSeekTargetMs(null)
		setQueue(initialRanges(chunks, plan))
	}, [enabled, chunks, plan, sessionId])

	const activeRange = queue[0]
	const loadedKeys = React.useMemo(() => new Set(loaded.map((entry) => entry.key)), [loaded])

	// One subscription, always mounted so the hook order never changes. With no
	// range to fetch it re-reads the last one, which the 10-minute atom TTL serves
	// from cache — chunk rows are immutable, so a repeat read is free.
	//
	// Before the manifest lands there is no range at all. Subscribing to an
	// invented window would fire a request for chunks we have no reason to think
	// exist, so hold at the plan's first range once there is one — that is where
	// playback starts for most sessions, making it a prefetch rather than waste.
	const subscribedRange = activeRange ??
		loaded[loaded.length - 1]?.range ??
		plan[0] ?? { fromChunkSeq: 0, toChunkSeq: 0 }
	const rangeResult = useAtomValue(
		getReplayEventsResultAtom({ data: replayRangeInput(sessionId, window, subscribedRange) }),
	)

	const loadError = React.useMemo(
		() =>
			activeRange === undefined
				? null
				: Result.builder(rangeResult)
						.onError((error) => error)
						.orElse(() => null),
		[rangeResult, activeRange],
	)

	// Commit a completed range and advance the queue.
	React.useEffect(() => {
		if (activeRange === undefined) return
		const key = rangeKey(activeRange)
		if (loadedKeys.has(key)) {
			setQueue((current) => current.slice(1))
			return
		}
		const committed = Result.builder(rangeResult)
			.onSuccess((result) => result)
			.orElse(() => null)
		if (committed === null) return
		const all = committed.chunks as ReadonlyArray<{ chunk_seq: number; events: string }>
		// Take only chunks this range is responsible for and that aren't already
		// loaded.
		//
		// The overlap is real on a LIVE session: the plan's last range is partial
		// while the recording is still being written, so a range loaded as 40–45
		// becomes 40–55 once more chunks land. That is a different key, so it is
		// fetched again — and without this filter chunks 40–45 would be handed to
		// `addEvent` a second time, replaying those mutations into the live engine.
		//
		// The range check also means a result that somehow belongs to a different
		// range is dropped rather than committed under this one's key.
		const alreadyThrough = loaded.reduce((max, entry) => Math.max(max, entry.lastChunkSeq), -1)
		const rows = all.filter(
			(row) =>
				row.chunk_seq >= activeRange.fromChunkSeq &&
				row.chunk_seq <= activeRange.toChunkSeq &&
				row.chunk_seq > alreadyThrough,
		)
		const events = decodeRange(rows)
		const lastChunkSeq = rows.reduce((max, row) => Math.max(max, row.chunk_seq), alreadyThrough)
		setLoaded((current) => [...current, { key, range: activeRange, events, lastChunkSeq }])
		setQueue((current) => current.slice(1))
	}, [rangeResult, activeRange, loadedKeys, loaded])

	// The seed is everything loaded before the queue first drains; after that,
	// arrivals are trailing and get fed to the live engine.
	React.useEffect(() => {
		if (queue.length === 0 && loaded.length > 0 && seedCount === 0) {
			setSeedCount(loaded.length)
			setIsSeeking(false)
		}
	}, [queue.length, loaded.length, seedCount])

	const seedEvents = React.useMemo(() => {
		if (seedCount === 0) return EMPTY
		return loaded.slice(0, seedCount).flatMap((entry) => entry.events)
	}, [loaded, seedCount])

	const trailingEvents = React.useMemo(() => {
		if (seedCount === 0) return EMPTY
		return loaded.slice(seedCount).flatMap((entry) => entry.events)
	}, [loaded, seedCount])

	/** Highest chunk sequence currently loaded, or -1. */
	const loadedThroughSeq = React.useMemo(
		() => loaded.reduce((max, entry) => Math.max(max, entry.lastChunkSeq), -1),
		[loaded],
	)

	/** Playback offset at which loaded events run out. */
	const loadedUntilMs = React.useMemo(() => {
		if (loadedThroughSeq < 0) return 0
		const last = chunks.find((chunk) => chunk.chunk_seq === loadedThroughSeq)
		if (last === undefined) return 0
		return chunkStartMs(last) + last.duration_ms - startMs
	}, [chunks, loadedThroughSeq, startMs])

	const hasMoreChunks = React.useMemo(() => {
		const lastSeq = chunks[chunks.length - 1]?.chunk_seq
		return lastSeq !== undefined && loadedThroughSeq >= 0 && loadedThroughSeq < lastSeq
	}, [chunks, loadedThroughSeq])

	/** Queue the next contiguous range, unless one is already in flight. */
	const enqueueNext = React.useCallback(() => {
		if (!hasMoreChunks) return
		setQueue((current) => {
			if (current.length > 0) return current
			const next = rangeContaining(plan, loadedThroughSeq + 1)
			if (next === undefined || loadedKeys.has(rangeKey(next))) return current
			return [next]
		})
	}, [hasMoreChunks, loadedThroughSeq, loadedKeys, plan])

	const reportProgress = React.useCallback(
		(offsetMs: number) => {
			playheadRef.current = offsetMs
			if (seedCount === 0) return
			if (offsetMs + PREFETCH_AHEAD_MS >= loadedUntilMs) enqueueNext()
		},
		[seedCount, loadedUntilMs, enqueueNext],
	)

	/**
	 * Ask to jump to a playback offset.
	 *
	 * Returns true when the engine must be rebuilt: the target is outside the
	 * loaded span, so playback has to restart from the nearest preceding
	 * checkpoint. rrweb applies an event whose timestamp precedes its baseline
	 * *synchronously and out of DOM order*, so feeding backwards through
	 * `addEvent` would corrupt the frame — a rebuild is the only correct move.
	 */
	const requestSeek = React.useCallback(
		(offsetMs: number): boolean => {
			playheadRef.current = offsetMs
			if (chunks.length === 0) return false
			const target = chunkAtOffset(chunks, offsetMs)
			if (target === undefined) return false
			const withinLoaded =
				target.chunk_seq <= loadedThroughSeq &&
				loaded.some(
					(entry) =>
						target.chunk_seq >= entry.range.fromChunkSeq &&
						target.chunk_seq <= entry.range.toChunkSeq,
				)
			if (withinLoaded) {
				// Already have it — the engine seeks itself, no transport needed.
				return false
			}
			const anchor = checkpointAtOrBefore(chunks, target.chunk_seq)
			if (anchor === undefined) return false
			setLoaded([])
			setSeedCount(0)
			setIsSeeking(true)
			setSeekTargetMs(offsetMs)
			setQueue(rangesCovering(chunks, plan, anchor.chunk_seq, INITIAL_WINDOW_BYTES))
			return true
		},
		[chunks, plan, loaded, loadedThroughSeq],
	)

	const bufferState: ReplayBufferState = isSeeking
		? "seeking"
		: // Starved: the playhead has reached the end of what's loaded and more is
			// still coming. Distinct from "finished", which is loadedThroughSeq at the
			// manifest's end.
			queue.length > 0 && seedCount > 0 && playheadRef.current + 1_000 >= loadedUntilMs && hasMoreChunks
			? "buffering"
			: "idle"

	return {
		seedEvents,
		trailingEvents,
		bufferState,
		loadError,
		seekTargetMs,
		requestSeek,
		reportProgress,
	}
}
