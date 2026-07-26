import { formatCHDateTime } from "../meta-row"
import { markActivity } from "../session"
import type { ReplayEngineConfig } from "./transport"
import { postSessionEvents } from "./transport"
import { installConsoleCapture } from "./capture/console"
import { installNetworkCapture } from "./capture/network"
import { installErrorCapture } from "./capture/errors"
import { installNavigationCapture } from "./capture/navigation"
import { installInteractionCapture } from "./capture/interactions"
import { approximateSize } from "./util"

/**
 * A distilled, structured session event. Sparse: only the fields relevant to
 * `type` are set. `timestamp`, `url`, and `traceId` are filled in by the buffer
 * if a capture module omits them, so modules only set what they actually know.
 */
export interface SessionEvent {
	type: "navigation" | "click" | "input" | "console" | "network" | "error"
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

const ZERO_TRACE_ID = "00000000000000000000000000000000"

// Injected by the host SDK (e.g. `@maple-dev/browser` wires OTel's
// `trace.getActiveSpan()`), keeping this engine free of tracing dependencies.
// Without a provider, events simply carry no trace id.
let traceIdProvider: () => string | undefined = () => undefined

/** Wire the host SDK's active-trace-id lookup into event capture. */
export function setActiveTraceIdProvider(provider: () => string | undefined): void {
	traceIdProvider = provider
}

/** The trace id of the active span, or undefined when none is active. */
export function activeTraceId(): string | undefined {
	const id = traceIdProvider()
	return id && id !== ZERO_TRACE_ID ? id : undefined
}

export interface EventCapture {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
	/** Navigations seen this session — becomes `page_views` on the metadata row. */
	getPageViews: () => number
	/**
	 * Errors seen this session — becomes `error_count`, which is what the
	 * Sessions UI's "has errors" filter tests. Counts uncaught errors and
	 * rejections plus `console.error`, since both are errors the user hit.
	 */
	getErrorCount: () => number
}

interface BufferedEvent {
	readonly ev: SessionEvent
	readonly seq: number
}

/**
 * Capture distilled session events (console, network, errors, navigation,
 * interactions) and ship them to the ingest gateway as NDJSON rows. Best-effort
 * and decoupled from the rrweb recorder — runs on its own flush loop.
 */
export function startEventCapture(config: ReplayEngineConfig, sessionId: string): EventCapture {
	let buffer: BufferedEvent[] = []
	let bufferBytes = 0
	let seq = 0
	let pageViews = 0
	let errorCount = 0

	const emit = (ev: SessionEvent): void => {
		// Counted here rather than in each capture module so every event type is
		// tallied on one path, and the totals survive the buffer being flushed.
		if (ev.type === "navigation") pageViews++
		else if (ev.type === "error" || (ev.type === "console" && ev.level === "error")) errorCount++
		buffer.push({ ev, seq: seq++ })
		bufferBytes += approximateSize(ev)
		if (bufferBytes >= FLUSH_BYTES) void flush()
	}

	const flush = async (keepalive = false): Promise<void> => {
		if (buffer.length === 0) return
		markActivity()
		const batch = buffer
		buffer = []
		bufferBytes = 0
		const rows = batch.map(({ ev, seq }) => toRow(sessionId, ev, seq))
		await postSessionEvents(config, rows, keepalive)
	}

	const ignoreUrl = (url: string): boolean => url.startsWith(`${config.endpoint}/v1/`)

	const uninstall = [
		installNavigationCapture(emit),
		installInteractionCapture(emit, config.maskAllText),
		installConsoleCapture(emit),
		installNetworkCapture(emit, ignoreUrl),
		installErrorCapture(emit),
	]

	const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)

	return {
		stop: () => {
			clearInterval(flushTimer)
			for (const off of uninstall) off()
		},
		flush,
		getPageViews: () => pageViews,
		getErrorCount: () => errorCount,
	}
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
