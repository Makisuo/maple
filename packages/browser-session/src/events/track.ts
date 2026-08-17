import { hasConsent } from "../identity/consent"
import { getActiveSink, queuePending, type SessionEvent } from "./events-sink"
import { coerceTrackProps, MAX_EVENT_NAME_LENGTH, type TrackProps } from "./props"

export type { TrackProps } from "./props"

let warnedAboutName = false

/**
 * Record a custom product event against the current session.
 *
 * Stored as a `session_events` row with `Type='custom'`, so it shows up inline
 * in the session transcript alongside the clicks and network calls that
 * surround it — not in a separate analytics silo.
 *
 * Safe to call before the SDK finishes initializing: events are queued (capped)
 * and drained once the sink starts. Never throws.
 */
export function track(name: string, props?: TrackProps): void {
	if (!hasConsent()) return
	if (typeof name !== "string" || name.trim().length === 0) {
		if (!warnedAboutName) {
			warnedAboutName = true
			console.warn("[maple] track() needs a non-empty event name; the call was ignored.")
		}
		return
	}

	const ev: SessionEvent = {
		type: "custom",
		message: name.trim().slice(0, MAX_EVENT_NAME_LENGTH),
		attrs: coerceTrackProps(props),
		timestamp: Date.now(),
		// Captured now rather than at flush time so a queued event reports the
		// page it actually happened on.
		url: typeof location !== "undefined" ? location.href : undefined,
	}

	const sink = getActiveSink()
	if (sink) sink.emit(ev)
	else queuePending(ev)
}
