import { startBaselineCapture } from "../capture/baseline"
import { formatCHDateTime } from "./meta-row"
import type { IngestConfig } from "../platform/transport"
import { postSessionEvents } from "../platform/transport"
import { approximateSize } from "../platform/approximate-size"
import { markActivity, noteNavigation } from "../session/session"
import { activeTraceId } from "./trace-id"

/**
 * A distilled, structured session event. Sparse: only the fields relevant to
 * `type` are set. `timestamp`, `url`, and `traceId` are filled in by the sink
 * if a producer omits them, so producers only set what they actually know.
 *
 * `custom` is the host app's own `track(name, props)`: `message` carries the
 * event name and `attrs` the properties. The gateway enforces this same set.
 */
export interface SessionEvent {
	type: "navigation" | "click" | "input" | "console" | "network" | "error" | "custom"
	timestamp?: number
	url?: string
	traceId?: string
	level?: string
	message?: string
	targetSelector?: string
	targetText?: string
	net?: { method: string; url: string; status: number; durationMs: number }
	errorStack?: string
	attrs?: Record<string, string>
}

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BYTES = 64 * 1024

export { activeTraceId, setActiveTraceIdProvider } from "./trace-id"

export interface SessionEventSink {
	/** Session currently receiving newly emitted rows. */
	readonly sessionId: string
	emit: (ev: SessionEvent) => void
	flush: (keepalive?: boolean) => Promise<void>
	stop: () => void
	/** Navigations seen this session — becomes `page_views` on the metadata row. */
	getPageViews: () => number
	/** Clicks seen by the distilled capture listeners for this sink. */
	getClickCount: () => number
	/**
	 * Errors seen this session — becomes `error_count`, which is what the
	 * Sessions UI's "has errors" filter tests. Counts uncaught errors and
	 * rejections plus `console.error`, since both are errors the user hit.
	 */
	getErrorCount: () => number
	/** True for URLs belonging to our own ingest endpoint (self-capture guard). */
	ignoreUrl: (url: string) => boolean
}

interface BufferedEvent {
	readonly ev: SessionEvent
	readonly seq: number
}

/**
 * The sink is a per-session singleton, published on `globalThis` rather than a
 * module-level variable.
 *
 * Two consumers can end up with separate copies of this module in one page (an
 * app bundling both `@maple-dev/browser` and the Effect SDK, or a
 * lazily-imported replay chunk). Two sinks would mean two `seq` counters
 * starting at 0, and `Seq` is part of the `session_events` sorting key — the
 * rows would collide. One global owner avoids that.
 */
const SINK_KEY = "__MAPLE_SESSION_EVENT_SINK__"

interface SinkHolder {
	sessionId: string
	sink: SessionEventSink
}

function holder(): Record<string, SinkHolder | undefined> {
	return globalThis as unknown as Record<string, SinkHolder | undefined>
}

/** The live sink, if one has been started. */
export function getActiveSink(): SessionEventSink | undefined {
	return holder()[SINK_KEY]?.sink
}

/**
 * Start (or reuse) the distilled-event sink for a session.
 *
 * Runs on **every** page load, not just sampled-for-replay ones: page views and
 * `track()` calls are the analytics substrate, and gating them behind replay
 * sampling would make unique visitors and top pages a sample rather than a
 * count. The rrweb recorder stays sampled — it is the expensive part.
 */
export function startEventSink(config: IngestConfig, sessionId: string): SessionEventSink {
	const existing = holder()[SINK_KEY]
	if (existing && existing.sessionId === sessionId) return existing.sink
	// A rotated session means a new sink; drain the old one first so its tail
	// isn't lost.
	if (existing) {
		void existing.sink.flush()
		existing.sink.stop()
	}

	let buffer: BufferedEvent[] = []
	let bufferBytes = 0
	let seq = 0
	let pageViews = 0
	let clickCount = 0
	let errorCount = 0

	const flush = async (keepalive = false): Promise<void> => {
		if (buffer.length === 0) return
		const batch = buffer
		buffer = []
		bufferBytes = 0
		const rows = batch.map(({ ev, seq }) => toRow(sessionId, ev, seq))
		await postSessionEvents(config, rows, keepalive)
	}

	const emit = (ev: SessionEvent): void => {
		// Activity is the rotation boundary. Resolve it before assigning the row
		// an id; if the previous session expired, hand the event to a fresh sink
		// instead of reviving the old record and continuing its seq counter.
		const session = markActivity()
		if (session && session.id !== sessionId) {
			const nextSink = startEventSink(config, session.id)
			// Starting the replacement sink emits its initial navigation. Replaying
			// the navigation that discovered the rotation would count the same page
			// twice; every other event still belongs to the new session.
			if (ev.type !== "navigation") nextSink.emit(ev)
			return
		}
		// Counted here rather than in each producer so every event type is
		// tallied on one path, and the totals survive the buffer being flushed.
		if (ev.type === "navigation") {
			pageViews++
			noteNavigation(ev.url ?? (typeof location !== "undefined" ? location.href : ""))
		} else if (ev.type === "click") clickCount++
		else if (ev.type === "error" || (ev.type === "console" && ev.level === "error")) errorCount++
		buffer.push({ ev, seq: seq++ })
		bufferBytes += approximateSize(ev)
		if (bufferBytes >= FLUSH_BYTES) void flush()
	}

	// Navigation is observed by the sink rather than by a capture module: page
	// views have to be counted even when replay is unsampled, and one owner of
	// the history patch avoids double-counting SPA transitions.
	const stopNavigation = installNavigationObserver((url) => {
		emit({ type: "navigation", url })
	})
	// Errors and clicks are counted on the same terms, and for the same reason —
	// see `startBaselineCapture`. Console and network capture stay on the sampled
	// replay path.
	const stopBaselineCapture = startBaselineCapture(emit, config.maskAllText)

	const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)

	const sink: SessionEventSink = {
		sessionId,
		emit,
		flush,
		stop: () => {
			clearInterval(flushTimer)
			stopNavigation()
			stopBaselineCapture()
			if (holder()[SINK_KEY]?.sink === sink) holder()[SINK_KEY] = undefined
		},
		getPageViews: () => pageViews,
		getClickCount: () => clickCount,
		getErrorCount: () => errorCount,
		ignoreUrl: (url: string) => url.startsWith(`${config.endpoint}/v1/`),
	}

	holder()[SINK_KEY] = { sessionId, sink }
	drainPending(sink)
	return sink
}

/**
 * Watch page views: the initial load plus every SPA navigation (history
 * pushState/replaceState, popstate, hashchange).
 */
function installNavigationObserver(onNavigate: (url: string) => void): () => void {
	if (typeof window === "undefined" || typeof history === "undefined") return () => {}
	let lastUrl = ""
	const emitNav = (): void => {
		const url = location.href
		// SPA frameworks often replaceState repeatedly with the same URL; dedupe.
		if (url === lastUrl) return
		lastUrl = url
		onNavigate(url)
	}

	emitNav() // initial page view

	const origPush = history.pushState
	const origReplace = history.replaceState
	history.pushState = function (this: History, ...args) {
		const result = origPush.apply(this, args as never)
		emitNav()
		return result
	}
	history.replaceState = function (this: History, ...args) {
		const result = origReplace.apply(this, args as never)
		emitNav()
		return result
	}
	window.addEventListener("popstate", emitNav)
	window.addEventListener("hashchange", emitNav)

	return () => {
		history.pushState = origPush
		history.replaceState = origReplace
		window.removeEventListener("popstate", emitNav)
		window.removeEventListener("hashchange", emitNav)
	}
}

// `track()` is a public API, so an app will call it from a click handler that
// fires before the SDK finished initializing (or before the lazily-imported
// replay chunk landed). Queue those instead of dropping them. Lives on
// globalThis for the same reason the sink does: one queue per page, not one per
// bundled copy of this module.

const PENDING_KEY = "__MAPLE_SESSION_EVENT_PENDING__"

const MAX_PENDING_EVENTS = 100
const MAX_PENDING_BYTES = 64 * 1024

interface PendingState {
	events: SessionEvent[]
	bytes: number
	warned: boolean
}

function pending(): PendingState {
	const global = globalThis as unknown as Record<string, PendingState | undefined>
	let state = global[PENDING_KEY]
	if (!state) {
		state = { events: [], bytes: 0, warned: false }
		global[PENDING_KEY] = state
	}
	return state
}

/**
 * Buffer an event until a sink exists. Drops oldest-first at the cap: an app
 * that calls `track()` in a loop before init should not be able to grow this
 * without bound.
 */
export function queuePending(ev: SessionEvent): void {
	const state = pending()
	state.events.push(ev)
	state.bytes += approximateSize(ev)
	while (
		state.events.length > MAX_PENDING_EVENTS ||
		(state.bytes > MAX_PENDING_BYTES && state.events.length > 1)
	) {
		const dropped = state.events.shift()
		if (!dropped) break
		state.bytes -= approximateSize(dropped)
		if (!state.warned) {
			state.warned = true
			console.warn(
				"[maple] dropping session events queued before init — call Maple.init/identify earlier, " +
					"or track() less before the SDK is ready.",
			)
		}
	}
}

/** Discard events captured before a consent-gated SDK was configured. */
export function clearPendingEvents(): void {
	const state = pending()
	state.events = []
	state.bytes = 0
}

/** Hand everything queued before init to the sink, oldest first. */
function drainPending(sink: SessionEventSink): void {
	const state = pending()
	if (state.events.length === 0) return
	const queued = state.events
	state.events = []
	state.bytes = 0
	for (const ev of queued) sink.emit(ev)
}

/** Map an internal event to the snake_case ingest row (org_id is added server-side). */
function toRow(sessionId: string, ev: SessionEvent, seq: number): Record<string, unknown> {
	return {
		session_id: sessionId,
		timestamp: formatCHDateTime(new Date(ev.timestamp ?? Date.now())),
		seq,
		type: ev.type,
		url: ev.url ?? (typeof location !== "undefined" ? location.href : ""),
		trace_id: ev.traceId ?? activeTraceId() ?? "",
		level: ev.level ?? "",
		message: ev.message ?? "",
		target_selector: ev.targetSelector ?? "",
		target_text: ev.targetText ?? "",
		net_method: ev.net?.method ?? "",
		net_url: ev.net?.url ?? "",
		net_status: ev.net?.status ?? 0,
		net_duration_ms: ev.net?.durationMs ?? 0,
		error_stack: ev.errorStack ?? "",
		attributes: ev.attrs ?? {},
	}
}

/** Test seam — drops the global sink and pending queue. */
export function resetSinkForTests(): void {
	const existing = holder()[SINK_KEY]
	if (existing) existing.sink.stop()
	holder()[SINK_KEY] = undefined
	const global = globalThis as unknown as Record<string, PendingState | undefined>
	global[PENDING_KEY] = undefined
}
