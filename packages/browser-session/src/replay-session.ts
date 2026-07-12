// The full replay-session lifecycle, shared by both SDKs: rrweb recording +
// distilled event capture + session metadata rows, with suspend/resume across
// tab visibility. `@maple-dev/browser` layers OTel tracing on top; the Effect
// client SDK loads this lazily (rrweb rides in a code-split chunk) when its
// `replay` option is on.
import { buildSessionMetaRow } from "./meta-row"
import { getSession, nextMetaVersion } from "./session"
import { getObservedTraceIds, publishSessionSink } from "./sink"
import { startEventCapture, type EventCapture } from "./replay/events"
import { startRecording, type Recorder } from "./replay/record"
import { postSessionMeta, type ReplayEngineConfig } from "./replay/transport"

export { setActiveTraceIdProvider } from "./replay/events"

export interface ReplaySessionOptions {
	readonly endpoint: string
	readonly ingestKey: string
	readonly serviceName: string
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	/** Consulted when metadata rows are posted, so `identify()` works late. */
	readonly getUserId?: (() => string | undefined) | undefined
}

export interface ReplaySessionHandle {
	readonly sessionId: string
	readonly shutdown: () => Promise<void>
}

/**
 * Start recording the current browser session. Publishes the session sink,
 * posts an `active` metadata row, and installs visibility handlers:
 * hidden → flush + `ended` row (with observed trace ids) + stop capture;
 * visible → re-resolve the session (rotating if idle-expired), republish the
 * sink, restart capture, post a fresh `active` row. Metadata versions are
 * monotonic per session, so the latest row always wins on the backend.
 *
 * Returns undefined outside a browser. Sampling is the caller's decision.
 */
export function startReplaySession(options: ReplaySessionOptions): ReplaySessionHandle | undefined {
	if (typeof window === "undefined") return undefined

	const engineConfig: ReplayEngineConfig = {
		endpoint: options.endpoint.replace(/\/$/, ""),
		ingestKey: options.ingestKey,
		maskAllInputs: options.maskAllInputs,
		maskAllText: options.maskAllText,
	}

	const session = getSession()
	let currentSessionId = session.id
	let currentStartedAt = new Date(session.startedAt)
	publishSessionSink(currentSessionId)

	let recorder: Recorder | undefined
	let events: EventCapture | undefined
	let stopped = false

	const postMeta = (status: "active" | "ended", clickCount: number | null, keepalive = false) =>
		postSessionMeta(
			engineConfig,
			buildSessionMetaRow({
				sessionId: currentSessionId,
				startedAt: currentStartedAt,
				version: nextMetaVersion(),
				status,
				serviceName: options.serviceName,
				userId: options.getUserId?.(),
				environment: options.environment,
				serviceVersion: options.serviceVersion,
				clickCount: clickCount ?? 0,
				traceIds: status === "ended" ? getObservedTraceIds() : undefined,
			}),
			keepalive,
		)

	const start = (): void => {
		recorder = startRecording(engineConfig, currentSessionId)
		// Distilled events (console/network/error/nav/clicks) ride along.
		events = startEventCapture(engineConfig, currentSessionId)
		void postMeta("active", null)
	}

	// Tab going away (maybe temporarily): flush everything with keepalive, post
	// the ended row, stop capture. Re-entrant — resume() restarts capture when
	// the tab becomes visible again, so a long-lived tab keeps recording across
	// tab switches instead of going silent until a reload.
	const suspend = (): void => {
		if (!recorder || !events) return
		void recorder.flush(true)
		void events.flush(true)
		void postMeta("ended", recorder.getClickCount(), true)
		// flush() snapshots its buffer synchronously before awaiting, so stopping
		// immediately after is safe and clears the rrweb subscription + timer.
		recorder.stop()
		events.stop()
		recorder = undefined
		events = undefined
	}

	// Tab visible again: the session may have rotated while hidden past the
	// idle window — re-resolve, republish the sink under the new id, restart.
	const resume = (): void => {
		if (stopped || recorder) return
		const next = getSession()
		if (next.id !== currentSessionId) {
			currentSessionId = next.id
			currentStartedAt = new Date(next.startedAt)
			publishSessionSink(currentSessionId)
		}
		start()
	}

	const onVisibilityChange = (): void => {
		if (document.visibilityState === "hidden") suspend()
		else resume()
	}
	// `visibilitychange → hidden` is the reliable "leaving" signal on mobile;
	// pagehide covers desktop tab close / navigation. A bfcache restore fires
	// `visibilitychange → visible`, which resumes capture.
	const onPageHide = (): void => suspend()

	start()
	document.addEventListener("visibilitychange", onVisibilityChange)
	window.addEventListener("pagehide", onPageHide)

	return {
		sessionId: currentSessionId,
		shutdown: async () => {
			stopped = true
			document.removeEventListener("visibilitychange", onVisibilityChange)
			window.removeEventListener("pagehide", onPageHide)
			if (recorder) await recorder.flush(true)
			if (events) await events.flush(true)
			recorder?.stop()
			events?.stop()
			recorder = undefined
			events = undefined
		},
	}
}
