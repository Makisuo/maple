import * as React from "react"
import { EventType, IncrementalSource, MouseInteractions } from "@rrweb/types"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { getReplayManifestResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ReplayEngine, ReplayEngineFactory, ReplayFormat } from "./engine/replay-engine"
import { rrwebEngineFactory } from "./engine/rrweb-engine"
import { videoEngineFactory, videoSegmentPayload } from "./engine/video-engine"
import { normalizeEvents } from "./replay-events"
import type { ReplayPartitionWindow } from "./replay-format"
import { manifestDurationMs, type ReplayChunkMeta } from "./replay-range"
import { useReplayChunkLoader } from "./use-replay-chunk-loader"
import { buildTimeline, type InactiveInterval, type Timeline } from "./replay-timeline"

// Replay player context
//
// The replay engine + transport state used to live inside the player surface.
// The video-editor layout renders the surface and the timeline strip in
// separate parts of the page, so both need to read `currentMs` and drive
// `seek`. This provider owns the engine and exposes that state via context;
// `<ReplaySurface>` and `<ReplayEditorTimeline>` are both consumers.
//
// The engine sits behind `ReplayEngine` (see `engine/replay-engine.ts`), so
// browser (rrweb) and mobile (H.264 segment) recordings both play here. Nothing
// below this provider knows or cares which one is mounted.

const EMPTY_CHUNKS: ReadonlyArray<ReplayChunkMeta> = []

/** Stable identity so the loader's budgets don't change on every manifest refetch. */
const EMPTY_LIMITS = {
	maxBytesPerRequest: undefined,
	maxChunksPerRequest: undefined,
} as const

/** A user interaction worth flagging on the scrubber. */
export type ActionKind = "click" | "input" | "scroll" | "nav"

/** An action marker positioned on the displayed (trimmed) timeline. */
export interface DisplayMarker {
	ms: number
	kind: ActionKind
}

/** An idle band positioned on the displayed (trimmed) timeline. */
export interface IdleBand {
	start: number
	end: number
}

/** `ms` is the real offset from session start (matching `getCurrentTime()`). */
interface ActionMarker {
	ms: number
	kind: ActionKind
}

/** Recorded viewport + action markers + idle gaps from the raw rrweb stream. */
interface DerivedMeta {
	recordedWidth: number
	recordedHeight: number
	/** First rrweb event timestamp (ms-epoch) — the playhead's time-zero. */
	startTime: number
	actionMarkers: ActionMarker[]
	inactiveIntervals: InactiveInterval[]
}

/** Gaps longer than this between meaningful events count as idle. */
const IDLE_THRESHOLD_MS = 2000

/**
 * Per-kind coalescing window: a marker is dropped if one of the same kind landed
 * within this many ms before it. Keystrokes (`input`) and scroll bursts collapse
 * into a single waypoint; clicks only dedupe double-clicks. `nav` is deduped by
 * URL instead, so its window is unused.
 */
const MARKER_COALESCE_MS: Record<ActionKind, number> = {
	click: 150,
	input: 800,
	scroll: 400,
	nav: 0,
} satisfies Record<ActionKind, number>

/**
 * Pointer drift and viewport jitter aren't "activity" for idle purposes — a user
 * reading a page while nudging the mouse is idle. Excluding these sources is what
 * makes a real idle stretch register as a gap (raw event cadence never goes quiet).
 */
function isMovementNoise(source: number | undefined): boolean {
	return (
		source === IncrementalSource.MouseMove ||
		source === IncrementalSource.TouchMove ||
		source === IncrementalSource.Drag ||
		source === IncrementalSource.ViewportResize
	)
}

/**
 * How long an event occupies the timeline.
 *
 * Almost everything rrweb records is instantaneous, but a mobile video segment
 * *spans* its duration: one event covers 30s of footage. Measuring idle from its
 * timestamp alone would mark every quiet segment as a 30s gap, and skip-idle
 * (on by default) would then collapse the whole recording to nothing.
 */
function eventSpanMs(event: unknown): number {
	const payload = videoSegmentPayload(event)
	if (!payload) return 0
	const duration = payload.duration
	return typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : 0
}

export function deriveMeta(events: ReadonlyArray<unknown>): DerivedMeta {
	let recordedWidth = 1280
	let recordedHeight = 720
	const actionMarkers: ActionMarker[] = []
	const inactiveIntervals: InactiveInterval[] = []
	const startTime = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0
	// Last *meaningful* (non-movement) event time — idle is measured against this.
	let prevMeaningfulTs = startTime
	const lastMsByKind: Partial<Record<ActionKind, number>> = {}
	let lastHref: string | undefined

	// Add a marker unless one of the same kind landed within its coalesce window.
	const pushMarker = (kind: ActionKind, ms: number) => {
		const last = lastMsByKind[kind]
		if (last !== undefined && ms - last < MARKER_COALESCE_MS[kind]) return
		lastMsByKind[kind] = ms
		actionMarkers.push({ ms, kind })
	}

	for (const raw of events) {
		const ev = raw as {
			type?: number
			timestamp?: number
			data?: {
				source?: number
				type?: number
				width?: number
				height?: number
				href?: string
			}
		}
		const isIncremental = ev.type === EventType.IncrementalSnapshot
		const source = isIncremental ? ev.data?.source : undefined

		if (typeof ev.timestamp === "number" && !(isIncremental && isMovementNoise(source))) {
			if (ev.timestamp - prevMeaningfulTs > IDLE_THRESHOLD_MS) {
				inactiveIntervals.push({
					start: prevMeaningfulTs - startTime,
					end: ev.timestamp - startTime,
				})
			}
			// A video segment stays "active" for its whole duration, so the next
			// segment starting right after it is continuous playback, not a gap.
			//
			// Monotonic on purpose. The iOS SDK emits `meta`, `video` and
			// `breadcrumb` all on the *same* timestamp, and the breadcrumb is
			// processed after the segment — a plain assignment would rewind the
			// watermark from (ts + duration) back to ts, and every segment would
			// register as a gap again. Verified against a real recording.
			prevMeaningfulTs = Math.max(prevMeaningfulTs, ev.timestamp + eventSpanMs(raw))
		}

		if (ev.type === EventType.Meta && ev.data) {
			if (typeof ev.data.width === "number") recordedWidth = ev.data.width
			if (typeof ev.data.height === "number") recordedHeight = ev.data.height
			// Periodic checkouts re-emit Meta with the same href — only a genuine URL
			// change is a navigation worth marking.
			if (typeof ev.data.href === "string" && typeof ev.timestamp === "number") {
				if (lastHref !== undefined && ev.data.href !== lastHref) {
					pushMarker("nav", ev.timestamp - startTime)
				}
				lastHref = ev.data.href
			}
		} else if (isIncremental && typeof ev.timestamp === "number") {
			const ms = ev.timestamp - startTime
			// Touch counts as a click. Mobile sessions only ever emit TouchStart, and
			// rrweb records touch on mobile *web* too — so before this, a phone
			// session of either kind produced no click markers at all.
			if (
				source === IncrementalSource.MouseInteraction &&
				(ev.data?.type === MouseInteractions.Click || ev.data?.type === MouseInteractions.TouchStart)
			) {
				pushMarker("click", ms)
			} else if (source === IncrementalSource.Input) {
				pushMarker("input", ms)
			} else if (source === IncrementalSource.Scroll) {
				pushMarker("scroll", ms)
			}
		}
	}
	return { recordedWidth, recordedHeight, startTime, actionMarkers, inactiveIntervals }
}

/**
 * `empty` and `unrecorded` are both "nothing to play", but they mean opposite
 * things to the viewer: `empty` is a recording that exists and is still
 * arriving (or is too short to play), `unrecorded` is a session that never had
 * one — replay was off or unsampled for that app. Showing a player for the
 * latter is a dead end, so the surface renders a plain explanation instead.
 */
type ReplayLoadStatus = "loading" | "error" | "empty" | "unrecorded" | "ready"

/**
 * Split "nothing to play" into its two causes, given the session's marker, its
 * chunk count, and whether it is still open.
 *
 * The SDK's `maple.session.recorded` marker is authoritative when present.
 * Without it (sessions written before the SDK stamped it), only a *closed*
 * session that never wrote a chunk can be called unrecorded — an open one may
 * still be uploading, and calling that "not recorded" would be wrong for the
 * whole time a live session is being watched.
 */
export function classifyUnplayable(input: {
	readonly recorded: boolean | undefined
	readonly chunkCount: number
	readonly sessionActive: boolean
}): "empty" | "unrecorded" {
	if (input.recorded === false) return "unrecorded"
	if (input.recorded === undefined && input.chunkCount === 0 && !input.sessionActive) {
		return "unrecorded"
	}
	return "empty"
}

export interface ReplayPlayerContextValue {
	status: ReplayLoadStatus
	error: unknown
	/** Refetch the manifest and the range that failed. */
	retry(): void
	/** Session still open — an `empty` status then means "chunks still arriving". */
	sessionActive: boolean
	/** Fullscreen target (the surface figure). */
	figureRef: React.RefObject<HTMLElement | null>
	surfaceRef: React.RefObject<HTMLDivElement | null>
	mountRef: React.RefObject<HTMLDivElement | null>
	isPlaying: boolean
	finished: boolean
	/** Current playhead position, in trimmed (display) ms. */
	displayCurrentMs: number
	/** Total length, in trimmed (display) ms. */
	displayTotalMs: number
	speed: number
	skipInactive: boolean
	isFullscreen: boolean
	markers: DisplayMarker[]
	idleBands: IdleBand[]
	/** Real⇄display mapping; used to align backend spans onto the timeline. */
	timeline: Timeline
	/** First rrweb event timestamp (ms-epoch) — span alignment time-zero. */
	recordingStartEpochMs: number
	/** Total length in rrweb's real clock (ms). */
	realTotalMs: number
	togglePlay(): void
	/** Seek to a position given in trimmed (display) ms. */
	seekDisplay(displayMs: number): void
	/** Seek relative to the engine's live clock, in trimmed (display) ms. */
	seekRelativeDisplay(deltaMs: number): void
	changeSpeed(s: number): void
	toggleSkipInactive(): void
	toggleFullscreen(): void
}

const ReplayPlayerContext = React.createContext<ReplayPlayerContextValue | null>(null)

export function useReplayPlayer(): ReplayPlayerContextValue {
	const ctx = React.useContext(ReplayPlayerContext)
	if (!ctx) throw new Error("useReplayPlayer must be used within a ReplayPlayerProvider")
	return ctx
}

const EMPTY_EVENTS: ReadonlyArray<unknown> = []

/** Read the engine's playhead, treating "no engine yet" as 0. */
function engineTimeMs(engine: ReplayEngine | null): number {
	return engine?.getCurrentTimeMs() ?? 0
}

const ENGINE_FACTORIES: Record<ReplayFormat, ReplayEngineFactory> = {
	rrweb: rrwebEngineFactory,
	video: videoEngineFactory,
} satisfies Record<ReplayFormat, ReplayEngineFactory>

export function ReplayPlayerProvider({
	sessionId,
	children,
	eventsOverride,
	window,
	recorded,
	format = "rrweb",
	sessionActive = false,
}: {
	sessionId: string
	children: React.ReactNode
	/** Test-only event injection that bypasses the warehouse fetch. */
	eventsOverride?: ReadonlyArray<unknown>
	/** Partition-pruning window; must match the route prefetch key (see $sessionId.tsx). */
	window?: ReplayPartitionWindow
	/**
	 * The session's `maple.session.recorded` marker. `undefined` for sessions
	 * written before the SDK stamped it — the status derivation then infers from
	 * `sessionActive` + chunk count instead.
	 */
	recorded?: boolean
	/**
	 * Which engine plays this session, from the SDK's
	 * `maple.session.replay_format` marker. Defaults to `rrweb`: every session
	 * recorded before the marker existed is a browser recording.
	 */
	format?: ReplayFormat
	/** Whether the session is still open (`status === "active"`), i.e. chunks may still arrive. */
	sessionActive?: boolean
}) {
	// The manifest — every chunk's position and size, no payloads. Cheap on any
	// session, and the prerequisite for deciding which payload ranges to fetch.
	const manifestAtom = getReplayManifestResultAtom({ data: { sessionId, ...window } })
	const manifestResult = useAtomValue(manifestAtom)
	const refreshManifest = useAtomRefresh(manifestAtom)

	const manifestChunks = React.useMemo<ReadonlyArray<ReplayChunkMeta>>(
		() =>
			Result.builder(manifestResult)
				.onSuccess((result) => result.chunks as ReadonlyArray<ReplayChunkMeta>)
				.orElse(() => EMPTY_CHUNKS),
		[manifestResult],
	)

	// The server's advertised per-request budgets, taken from the same manifest
	// the ranges are planned from, so the plan and the endpoint agree on what
	// fits. Undefined until it lands.
	const manifestLimits = React.useMemo(
		() =>
			Result.builder(manifestResult)
				.onSuccess((result) => ({
					maxBytesPerRequest: result.max_bytes_per_request,
					maxChunksPerRequest: result.max_chunks_per_request,
				}))
				.orElse(() => EMPTY_LIMITS),
		[manifestResult],
	)

	const loader = useReplayChunkLoader({
		sessionId,
		window,
		chunks: manifestChunks,
		maxBytesPerRequest: manifestLimits.maxBytesPerRequest,
		maxChunksPerRequest: manifestLimits.maxChunksPerRequest,
		// Tests can supply events directly without hitting the network.
		enabled: eventsOverride === undefined,
	})

	// Normalized separately from the status derivation below, and keyed only on
	// the injected array. Doing it inline would mint a fresh array on every
	// recompute of that memo — see the identity note on `events`.
	const overrideEvents = React.useMemo(
		() => (eventsOverride ? normalizeEvents(eventsOverride) : undefined),
		[eventsOverride],
	)

	// `events` is the engine's mount key, so its IDENTITY is load-bearing, not
	// just its contents. This memo depends on `manifestResult`, which changes on
	// every manifest refetch — so building a new array in here (a `normalizeEvents`
	// call, or a `[...loader.seedEvents]` spread) tears the engine down and
	// rebuilds it every few seconds on a live session. Both branches now hand back
	// an already-stable array instead.
	const { status, error, events } = React.useMemo<{
		status: ReplayLoadStatus
		error: unknown
		events: ReadonlyArray<unknown>
	}>(() => {
		if (eventsOverride) {
			const decoded = overrideEvents ?? EMPTY_EVENTS
			if (decoded.length >= 2) return { status: "ready" as const, error: null, events: decoded }
			// Keep injected tests on the same status path as warehouse-loaded sessions.
			return {
				status: classifyUnplayable({
					recorded,
					chunkCount: eventsOverride.length,
					sessionActive,
				}),
				error: null,
				events: EMPTY_EVENTS,
			}
		}
		if (loader.loadError !== null) {
			return { status: "error" as const, error: loader.loadError, events: EMPTY_EVENTS }
		}
		return Result.builder(manifestResult)
			.onInitial(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
			.onError((e) => ({ status: "error" as const, error: e, events: EMPTY_EVENTS }))
			.onSuccess((result) => {
				// Emptiness is now decided from the manifest — no longer requiring a
				// download of the whole session just to discover there's nothing in it.
				const chunkCount = result.chunks.length
				if (chunkCount === 0) {
					return {
						status: classifyUnplayable({ recorded, chunkCount, sessionActive }),
						error: null,
						events: EMPTY_EVENTS,
					}
				}
				if (loader.seedEvents.length >= 2) {
					return { status: "ready" as const, error: null, events: loader.seedEvents }
				}
				// Manifest says there are chunks; the opening window is still in
				// flight, or every chunk in it was unparseable.
				return loader.seedEvents.length > 0
					? {
							status: classifyUnplayable({ recorded, chunkCount, sessionActive }),
							error: null,
							events: EMPTY_EVENTS,
						}
					: { status: "loading" as const, error: null, events: EMPTY_EVENTS }
			})
			.orElse(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
	}, [
		manifestResult,
		eventsOverride,
		overrideEvents,
		recorded,
		sessionActive,
		loader.seedEvents,
		loader.loadError,
	])

	// Playable length from the manifest — known before any payload is fetched.
	const manifestTotalMs = React.useMemo(() => manifestDurationMs(manifestChunks), [manifestChunks])
	const seekTargetMs = loader.seekTargetMs
	const { requestSeek, reportProgress } = loader
	/** How many trailing events have been handed to the engine already. */
	const fedCountRef = React.useRef(0)

	const figureRef = React.useRef<HTMLElement | null>(null)
	const surfaceRef = React.useRef<HTMLDivElement | null>(null)
	const mountRef = React.useRef<HTMLDivElement | null>(null)
	const engineRef = React.useRef<ReplayEngine | null>(null)

	const { recordedWidth, recordedHeight, startTime, actionMarkers, inactiveIntervals } = React.useMemo(
		() => deriveMeta(events),
		[events],
	)

	const [isPlaying, setIsPlaying] = React.useState(false)
	const [finished, setFinished] = React.useState(false)
	const [currentMs, setCurrentMs] = React.useState(0)
	const [totalMs, setTotalMs] = React.useState(0)
	const [speed, setSpeed] = React.useState(1)
	const [skipInactive, setSkipInactive] = React.useState(true)
	const [isFullscreen, setIsFullscreen] = React.useState(false)

	// While skip-idle is on, present the timeline in active time: idle gaps
	// collapse so the clock/scrubber match the (already idle-skipping) playback.
	const timeline = React.useMemo(
		() => buildTimeline(skipInactive ? inactiveIntervals : [], totalMs),
		[inactiveIntervals, totalMs, skipInactive],
	)
	const displayCurrentMs = timeline.toDisplay(currentMs)
	const displayTotalMs = timeline.activeTotalMs
	const markers = React.useMemo<DisplayMarker[]>(
		() => actionMarkers.map((m) => ({ ms: timeline.toDisplay(m.ms), kind: m.kind })),
		[actionMarkers, timeline],
	)
	const idleBands = React.useMemo<IdleBand[]>(
		() =>
			inactiveIntervals.map((iv) => ({
				start: timeline.toDisplay(iv.start),
				end: timeline.toDisplay(iv.end),
			})),
		[inactiveIntervals, timeline],
	)

	// Re-fit the recording inside the fixed-size surface. How that is done is the
	// engine's business (rrweb transforms its wrapper; the video element just uses
	// `object-fit: contain`) — the provider only says *when*.
	//
	// Deliberately dep-free and referentially stable: the recorded viewport is
	// handed to the engine at construction instead, which keeps `recordedWidth`
	// and `recordedHeight` out of the mount effect's dependency list below.
	const applyScale = React.useCallback(() => {
		const container = surfaceRef.current
		if (!container) return
		engineRef.current?.fit(container)
	}, [])

	// Mirror document fullscreen state so the surface rescales + the button swaps.
	React.useEffect(() => {
		const onChange = () => setIsFullscreen(document.fullscreenElement === figureRef.current)
		document.addEventListener("fullscreenchange", onChange)
		return () => document.removeEventListener("fullscreenchange", onChange)
	}, [])

	const toggleFullscreen = React.useCallback(() => {
		if (document.fullscreenElement) void document.exitFullscreen()
		else void figureRef.current?.requestFullscreen()
	}, [])

	// Mount the engine once events are ready. Keyed on `events` — a fresh session
	// rebuilds. The surface's mount div is committed before this parent effect runs.
	// The returned cleanup calls observer.disconnect() + engine.destroy(), which
	// tears down whatever listeners the engine registered.
	// react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- The returned engine teardown disconnects the observer and destroys registered listeners.
	React.useEffect(() => {
		if (status !== "ready") return
		const mount = mountRef.current
		if (!mount) return
		mount.innerHTML = ""

		const engine = ENGINE_FACTORIES[format].create({
			mount,
			events,
			// The engine prefers its own live viewport when it has one; this is the
			// statically-derived fallback from the stream's Meta events.
			fallbackViewport: { width: recordedWidth || 1280, height: recordedHeight || 720 },
			onFinish: () => {
				setIsPlaying(false)
				setFinished(true)
			},
			// The recorded viewport can change mid-session (responsive / window
			// resize / device rotation). Re-fit so the recording stays centered in
			// the fixed surface. Also fires for the initial frame.
			onResize: () => applyScale(),
		})
		engineRef.current = engine
		setTotalMs(engine.totalTimeMs)
		setCurrentMs(0)
		setFinished(false)
		setIsPlaying(false)
		fedCountRef.current = 0

		const observer = new ResizeObserver(() => applyScale())
		if (surfaceRef.current) observer.observe(surfaceRef.current)
		applyScale()

		return () => {
			observer.disconnect()
			engine.destroy()
			engineRef.current = null
			mount.innerHTML = ""
		}
		// Keyed on the SEED, and on nothing else that moves.
		//
		// `events` here is the loader's seed, which only changes on first load or a
		// seek that needs a new anchor. Anything else in this list — the manifest
		// total, a seek target — rebuilds the engine whenever it moves, and for a
		// live session the manifest moves constantly: the iframe flashes and the
		// playhead snaps back to 0 every few seconds, which reads as "playback is
		// frozen". Trailing events and the total are applied by the effects below.
		//
		// `recordedWidth`/`recordedHeight` are derived from `events` and `format`
		// is a per-session prop, so neither adds churn beyond the seed itself.
	}, [events, status, applyScale, format, recordedWidth, recordedHeight])

	// The manifest knows the full length before the payload is loaded, so the
	// scrubber shows the real duration from the first frame. `getMetaData()` would
	// report only the loaded span and visibly stretch as chunks stream in — but it
	// is still the right answer for injected test events, which have no manifest.
	React.useEffect(() => {
		if (manifestTotalMs > 0) setTotalMs(manifestTotalMs)
	}, [manifestTotalMs])

	// Resume where the user asked after a seek-driven rebuild. Separate from the
	// mount effect so that a new seek target never reconstructs the engine.
	React.useEffect(() => {
		const engine = engineRef.current
		if (!engine || status !== "ready" || seekTargetMs === null) return
		engine.pause(seekTargetMs)
		setCurrentMs(seekTargetMs)
	}, [seekTargetMs, status])

	// Feed newly-arrived events into the live engine.
	//
	// Only ever forward: every trailing event postdates the seed, so rrweb
	// binary-inserts it and queues it on its own timer. An event that predates
	// the baseline would instead be applied synchronously and out of DOM order —
	// which is why a backward seek rebuilds (see `requestSeek`) rather than
	// arriving here.
	React.useEffect(() => {
		const engine = engineRef.current
		if (!engine || status !== "ready") return
		const pending = loader.trailingEvents.slice(fedCountRef.current)
		if (pending.length === 0) return
		for (const event of pending) engine.addEvent(event)
		fedCountRef.current = loader.trailingEvents.length
	}, [loader.trailingEvents, status])

	// Recompute scale when entering/leaving fullscreen.
	React.useEffect(() => {
		applyScale()
	}, [isFullscreen, applyScale])

	// Poll the engine clock while playing (rrweb has no per-frame time event).
	// While skip-idle is on, jump straight over any inactive gap we land in.
	React.useEffect(() => {
		if (!isPlaying) return
		let raf = 0
		// Remember the gap we last jumped out of so we don't re-issue play() every
		// frame before the engine clock catches up (which would thrash pause/play).
		let lastJumpedEnd = -1
		const tick = () => {
			const engine = engineRef.current
			if (engine) {
				const cur = engine.getCurrentTimeMs()
				const gap = skipInactive && inactiveIntervals.find((iv) => cur >= iv.start && cur < iv.end)
				if (gap && gap.end !== lastJumpedEnd) {
					lastJumpedEnd = gap.end
					// Explicit pause→play forces the engine to seek; play(offset) alone
					// can no-op while already playing in @rrweb/replay.
					engine.pause(gap.end)
					engine.play(gap.end)
					setCurrentMs(gap.end)
				} else if (!gap) {
					lastJumpedEnd = -1
					setCurrentMs(Math.min(Math.max(0, cur), totalMs))
				}
				// Keep the loader ahead of the playhead — this is what turns the
				// opening window into continuous playback.
				reportProgress(cur)
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [isPlaying, totalMs, inactiveIntervals, skipInactive, reportProgress])

	// Hold playback when the playhead outruns the loaded events, and release it
	// when the next range lands. Without this the engine plays into an empty
	// timeline and reports "finished" halfway through the recording.
	// Gated on an actual stall having happened: an unconditional `play()` on every
	// idle render would re-issue playback the user never paused, and double up on
	// the transport controls' own play calls.
	const stalledRef = React.useRef(false)
	React.useEffect(() => {
		const engine = engineRef.current
		if (!engine || !isPlaying) return
		if (loader.bufferState === "buffering") {
			stalledRef.current = true
			engine.pause()
		} else if (loader.bufferState === "idle" && stalledRef.current) {
			stalledRef.current = false
			engine.play(engineTimeMs(engine))
		}
	}, [loader.bufferState, isPlaying])

	const togglePlay = React.useCallback(() => {
		const engine = engineRef.current
		if (!engine) return
		if (finished) {
			engine.play(0)
			setCurrentMs(0)
			setFinished(false)
			setIsPlaying(true)
		} else if (isPlaying) {
			engine.pause()
			setIsPlaying(false)
		} else {
			const engineCurrentMs = engineTimeMs(engine)
			const from = engineCurrentMs >= totalMs ? 0 : engineCurrentMs
			engine.play(from)
			setIsPlaying(true)
		}
	}, [finished, isPlaying, totalMs])

	// rrweb's `pause(offset)` rebuilds the DOM synchronously — expensive. Pointer
	// devices fire `pointermove` far above 60Hz, so seeking on every raw event
	// thrashes the engine and re-renders. Coalesce to one engine seek per frame:
	// the scrubbers write the latest target and we apply only the last one.
	const pendingSeekRef = React.useRef<{
		displayMs: number
		totalMs: number
		timeline: Timeline
		isPlaying: boolean
	} | null>(null)
	const seekRafRef = React.useRef<number | null>(null)

	const applySeek = React.useCallback(() => {
		seekRafRef.current = null
		const pending = pendingSeekRef.current
		pendingSeekRef.current = null
		if (pending === null) return
		const engine = engineRef.current
		if (!engine) return
		// `displayMs` arrives in trimmed-timeline space; map back to rrweb's real
		// clock before driving the engine. The pending request snapshots the latest
		// playback state at the call site and is overwritten by newer pointer moves.
		const clamped = Math.max(0, Math.min(pending.timeline.toReal(pending.displayMs), pending.totalMs))
		setCurrentMs(clamped)
		if (clamped < pending.totalMs) setFinished(false)
		// Seeking outside the loaded span rebuilds the engine from the nearest
		// preceding checkpoint (the only thing rrweb can start from). The rebuild
		// resumes at this offset, so don't also drive the doomed current engine.
		if (requestSeek(clamped)) return
		if (pending.isPlaying && clamped < pending.totalMs) engine.play(clamped)
		else engine.pause(clamped)
	}, [requestSeek])

	const seekDisplay = React.useCallback(
		(displayMs: number) => {
			pendingSeekRef.current = { displayMs, totalMs, timeline, isPlaying }
			if (seekRafRef.current === null) {
				seekRafRef.current = requestAnimationFrame(applySeek)
			}
		},
		[applySeek, isPlaying, timeline, totalMs],
	)

	const seekRelativeDisplay = React.useCallback(
		(deltaMs: number) => {
			const currentRealMs = engineTimeMs(engineRef.current)
			seekDisplay(timeline.toDisplay(currentRealMs) + deltaMs)
		},
		[seekDisplay, timeline],
	)

	React.useEffect(
		() => () => {
			if (seekRafRef.current !== null) cancelAnimationFrame(seekRafRef.current)
		},
		[],
	)

	const changeSpeed = React.useCallback((next: number) => {
		setSpeed(next)
		engineRef.current?.setSpeed(next)
	}, [])

	const toggleSkipInactive = React.useCallback(() => {
		setSkipInactive((prev) => !prev)
	}, [])

	// Refetch both reads the player depends on: the failure can be in either,
	// and from here there is no way to tell which without inspecting the error.
	const retryRange = loader.retryRange
	const retry = React.useCallback(() => {
		refreshManifest()
		retryRange()
	}, [refreshManifest, retryRange])

	const value = React.useMemo<ReplayPlayerContextValue>(
		() => ({
			status,
			error,
			retry,
			sessionActive,
			figureRef,
			surfaceRef,
			mountRef,
			isPlaying,
			finished,
			displayCurrentMs,
			displayTotalMs,
			speed,
			skipInactive,
			isFullscreen,
			markers,
			idleBands,
			timeline,
			recordingStartEpochMs: startTime,
			realTotalMs: totalMs,
			togglePlay,
			seekDisplay,
			seekRelativeDisplay,
			changeSpeed,
			toggleSkipInactive,
			toggleFullscreen,
		}),
		[
			status,
			error,
			retry,
			sessionActive,
			isPlaying,
			finished,
			displayCurrentMs,
			displayTotalMs,
			speed,
			skipInactive,
			isFullscreen,
			markers,
			idleBands,
			timeline,
			startTime,
			totalMs,
			togglePlay,
			seekDisplay,
			seekRelativeDisplay,
			changeSpeed,
			toggleSkipInactive,
			toggleFullscreen,
		],
	)

	return <ReplayPlayerContext.Provider value={value}>{children}</ReplayPlayerContext.Provider>
}
