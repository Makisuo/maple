import * as React from "react"
import { Replayer } from "@rrweb/replay"
import { EventType, IncrementalSource, MouseInteractions, ReplayerEvents } from "@rrweb/types"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getReplayEventsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { normalizeEvents } from "./replay-events"
import type { ReplayPartitionWindow } from "./replay-format"
import { buildTimeline, type InactiveInterval, type Timeline } from "./replay-timeline"

// ---------------------------------------------------------------------------
// Replay player context
//
// The rrweb engine + transport state used to live inside the player surface.
// The video-editor layout renders the surface and the timeline strip in
// separate parts of the page, so both need to read `currentMs` and drive
// `seek`. This provider owns the engine and exposes that state via context;
// `<ReplaySurface>` and `<ReplayEditorTimeline>` are both consumers.
// ---------------------------------------------------------------------------

interface ReplayChunk {
	readonly chunkSeq: number
	readonly events: string
}

/** Sort chunks by sequence, parse each chunk's inline rrweb event JSON, and normalize. */
function decodeChunks(chunks: ReadonlyArray<ReplayChunk>): unknown[] {
	const ordered = [...chunks].sort((a, b) => a.chunkSeq - b.chunkSeq)
	const all: unknown[] = []
	for (const chunk of ordered) {
		try {
			const parsed: unknown = JSON.parse(chunk.events)
			if (Array.isArray(parsed)) all.push(...parsed)
		} catch {
			// Skip a malformed chunk rather than failing the whole replay.
		}
	}
	return normalizeEvents(all)
}

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
}

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

function deriveMeta(events: unknown[]): DerivedMeta {
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
			prevMeaningfulTs = ev.timestamp
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
			if (source === IncrementalSource.MouseInteraction && ev.data?.type === MouseInteractions.Click) {
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

type ReplayLoadStatus = "loading" | "error" | "empty" | "ready"

export interface ReplayPlayerContextValue {
	status: ReplayLoadStatus
	error: unknown
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

const EMPTY_EVENTS: unknown[] = []

export function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message: unknown }).message
		if (typeof message === "string") return message
	}
	return String(error)
}

export function ReplayPlayerProvider({
	sessionId,
	children,
	previewEvents,
	window,
}: {
	sessionId: string
	children: React.ReactNode
	/**
	 * Escape hatch for the placeholder-data preview route: a ready-made rrweb
	 * event array that bypasses the warehouse fetch entirely. Production callers
	 * never pass this, so the atom path below is unchanged.
	 */
	previewEvents?: ReadonlyArray<unknown>
	/** Partition-pruning window; must match the route prefetch key (see $sessionId.tsx). */
	window?: ReplayPartitionWindow
}) {
	// Chunks carry their rrweb events inline (read straight from ClickHouse); parse
	// + concatenate them in order. Memoized on the (referentially stable) result so
	// deriveMeta/engine memos hold across the player's frequent re-renders.
	const eventsResult = useAtomValue(getReplayEventsResultAtom({ data: { sessionId, ...window } }))

	const { status, error, events } = React.useMemo<{
		status: ReplayLoadStatus
		error: unknown
		events: unknown[]
	}>(() => {
		if (previewEvents) {
			const decoded = normalizeEvents(previewEvents)
			return decoded.length >= 2
				? { status: "ready" as const, error: null, events: decoded }
				: { status: "empty" as const, error: null, events: EMPTY_EVENTS }
		}
		return Result.builder(eventsResult)
			.onInitial(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
			.onError((e) => ({ status: "error" as const, error: e, events: EMPTY_EVENTS }))
			.onSuccess((result) => {
				const decoded = decodeChunks(result.chunks as ReadonlyArray<ReplayChunk>)
				return decoded.length >= 2
					? { status: "ready" as const, error: null, events: decoded }
					: { status: "empty" as const, error: null, events: EMPTY_EVENTS }
			})
			.orElse(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
	}, [eventsResult, previewEvents])

	const figureRef = React.useRef<HTMLElement | null>(null)
	const surfaceRef = React.useRef<HTMLDivElement | null>(null)
	const mountRef = React.useRef<HTMLDivElement | null>(null)
	const replayerRef = React.useRef<Replayer | null>(null)

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

	// Fit the recorded page *inside* the fixed-size surface (contain + letterbox),
	// centered on both axes. The surface keeps a constant box (CSS aspect-ratio /
	// fullscreen flex), so the player height never jumps between recordings.
	//
	// Scale against the iframe rrweb actually built, not the statically-derived
	// `recordedWidth` — a session can carry several Meta events (viewport resizes),
	// and deriveMeta keeps the last one, which may not match the current frame.
	// The iframe's width/height attributes always reflect the current viewport,
	// and the `Resize` listener re-runs this when they change mid-playback.
	const applyScale = React.useCallback(() => {
		const replayer = replayerRef.current
		const container = surfaceRef.current
		if (!replayer || !container) return
		const vw = Number(replayer.iframe?.getAttribute("width")) || recordedWidth || 1280
		const vh = Number(replayer.iframe?.getAttribute("height")) || recordedHeight || 720
		const availW = container.clientWidth
		const availH = container.clientHeight
		if (!availW || !availH || !vw || !vh) return
		const scale = Math.min(availW / vw, availH / vh)
		const offsetX = Math.max(0, (availW - vw * scale) / 2)
		const offsetY = Math.max(0, (availH - vh * scale) / 2)
		replayer.wrapper.style.transformOrigin = "top left"
		replayer.wrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
	}, [recordedWidth, recordedHeight])

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
	// The returned cleanup calls observer.disconnect() + replayer.destroy(), which
	// tears down every replayer.on(...) subscription registered below.
	// oxlint-disable-next-line react-doctor/effect-needs-cleanup
	React.useEffect(() => {
		if (status !== "ready") return
		const mount = mountRef.current
		if (!mount) return
		mount.innerHTML = ""

		const accent =
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#6366f1"

		const replayer = new Replayer(events as never, {
			root: mount,
			speed: 1,
			// We skip idle ourselves by jumping (see the rAF loop) — rrweb's own
			// skipInactive only fast-forwards, which is slow. Keep it off.
			skipInactive: false,
			mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: accent },
			showWarning: false,
			showDebug: false,
			liveMode: false,
		})
		replayerRef.current = replayer
		setTotalMs(replayer.getMetaData().totalTime)
		setCurrentMs(0)
		setFinished(false)
		setIsPlaying(false)

		// rrweb's own transport events are unreliable in @rrweb/replay (Start/Resume
		// often don't fire); play/pause state is driven from our handlers. We still
		// honour Finish to flip back to the replay affordance at the end.
		replayer.on(ReplayerEvents.Finish, () => {
			setIsPlaying(false)
			setFinished(true)
		})

		// The recorded viewport can change mid-session (responsive / window resize);
		// rrweb resizes its iframe and emits Resize. Re-fit so the recording stays
		// centered in the fixed surface. Also fires for the initial snapshot.
		replayer.on(ReplayerEvents.Resize, () => applyScale())

		const observer = new ResizeObserver(() => applyScale())
		if (surfaceRef.current) observer.observe(surfaceRef.current)
		applyScale()

		return () => {
			observer.disconnect()
			replayer.destroy()
			replayerRef.current = null
			mount.innerHTML = ""
		}
	}, [events, status, applyScale])

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
			const replayer = replayerRef.current
			if (replayer) {
				const cur = replayer.getCurrentTime()
				const gap = skipInactive && inactiveIntervals.find((iv) => cur >= iv.start && cur < iv.end)
				if (gap && gap.end !== lastJumpedEnd) {
					lastJumpedEnd = gap.end
					// Explicit pause→play forces the engine to seek; play(offset) alone
					// can no-op while already playing in @rrweb/replay.
					replayer.pause(gap.end)
					replayer.play(gap.end)
					setCurrentMs(gap.end)
				} else if (!gap) {
					lastJumpedEnd = -1
					setCurrentMs(Math.min(cur, totalMs))
				}
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [isPlaying, totalMs, inactiveIntervals, skipInactive])

	const togglePlay = React.useCallback(() => {
		const replayer = replayerRef.current
		if (!replayer) return
		if (finished) {
			replayer.play(0)
			setCurrentMs(0)
			setFinished(false)
			setIsPlaying(true)
		} else if (isPlaying) {
			replayer.pause()
			setIsPlaying(false)
		} else {
			const engineCurrentMs = replayer.getCurrentTime()
			const from = engineCurrentMs >= totalMs ? 0 : engineCurrentMs
			replayer.play(from)
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
		const replayer = replayerRef.current
		if (!replayer) return
		// `displayMs` arrives in trimmed-timeline space; map back to rrweb's real
		// clock before driving the engine. The pending request snapshots the latest
		// playback state at the call site and is overwritten by newer pointer moves.
		const clamped = Math.max(0, Math.min(pending.timeline.toReal(pending.displayMs), pending.totalMs))
		setCurrentMs(clamped)
		if (clamped < pending.totalMs) setFinished(false)
		if (pending.isPlaying && clamped < pending.totalMs) replayer.play(clamped)
		else replayer.pause(clamped)
	}, [])

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
			const currentRealMs = replayerRef.current?.getCurrentTime() ?? 0
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
		replayerRef.current?.setConfig({ speed: next })
	}, [])

	const toggleSkipInactive = React.useCallback(() => {
		setSkipInactive((prev) => !prev)
	}, [])

	const value = React.useMemo<ReplayPlayerContextValue>(
		() => ({
			status,
			error,
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
