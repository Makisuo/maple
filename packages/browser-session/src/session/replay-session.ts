// The full replay-session lifecycle, shared by both SDKs: rrweb recording +
// distilled event capture + session metadata rows, with suspend/resume across
// tab visibility. `@maple-dev/browser` layers OTel tracing on top; the Effect
// client SDK loads this lazily (rrweb rides in a code-split chunk) when its
// `replay` option is on.
//
// Everything about the lifecycle itself — heartbeat, visibility/pagehide
// wiring, idle rotation, metadata rows — lives in `./lifecycle`, shared
// with the metadata-only path. This module is the recorded configuration of it.
import { type EventCapture, startEventCapture } from "../replay/events"
import { type Recorder, startRecording } from "../replay/record"
import { postSessionMeta, type IngestConfig } from "../platform/transport"
import { type SessionLifecycleHandle, type SessionLifecycleOptions, startSessionLifecycle } from "./lifecycle"
import { getObservedTraceIds, publishSessionSink } from "./sink"

export { setActiveTraceIdProvider } from "../events/events-sink"

export interface ReplaySessionOptions extends SessionLifecycleOptions {
	readonly endpoint: string
	readonly ingestKey: string
	/** `x-maple-sdk` value — `sdkHint(name, version)`. */
	readonly sdk: string
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	/** Notifies consumers that the session id used for span linking changed. */
	readonly onSessionChange?: ((sessionId: string) => void) | undefined
}

export type ReplaySessionHandle = SessionLifecycleHandle

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

	const engineConfig: IngestConfig = {
		endpoint: options.endpoint.replace(/\/$/, ""),
		ingestKey: options.ingestKey,
		sdk: options.sdk,
		maskAllInputs: options.maskAllInputs,
		maskAllText: options.maskAllText,
	}

	let recorder: Recorder | undefined
	let events: EventCapture | undefined
	let publishedSessionId: string | undefined

	const publish = (sessionId: string): void => {
		if (publishedSessionId === sessionId) return
		publishedSessionId = sessionId
		publishSessionSink(sessionId)
	}

	return startSessionLifecycle(
		{ ...options, getTraceIds: getObservedTraceIds },
		{
			// This path *is* the recorder — every row it posts has rrweb chunks.
			recorded: true,
			post: (row, keepalive) => {
				void postSessionMeta(engineConfig, row, keepalive)
			},
			// rrweb sees mouse interactions the distilled capture may mask away, so
			// the recorder is the better click source while it is running.
			clicksSinceStart: () => recorder?.getClickCount() ?? 0,
			onStart: (record) => {
				publish(record.id)
				recorder = startRecording(engineConfig, record.id)
				// Distilled events (console/network/error/clicks) ride along.
				// Navigation is observed by the sink, which runs whether or not replay
				// is sampled.
				events = startEventCapture(engineConfig, record.id)
			},
			onSuspend: ({ flush, keepalive }) => {
				const stoppingRecorder = recorder
				const stoppingEvents = events
				recorder = undefined
				events = undefined
				const flushed = flush
					? Promise.all([
							stoppingRecorder?.flush(keepalive),
							stoppingEvents?.flush(keepalive),
						]).then(() => {})
					: undefined
				// flush() snapshots its buffer synchronously before awaiting, so
				// stopping immediately after is safe — and stopping before the await
				// is what makes a consent revoke detach every producer at once.
				stoppingRecorder?.stop()
				stoppingEvents?.stop()
				return flushed
			},
			onSessionChange: (sessionId) => {
				publish(sessionId)
				options.onSessionChange?.(sessionId)
			},
		},
	)
}
