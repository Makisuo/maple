import { hasConsent } from "./consent"
import { getActiveSink, queuePending, type SessionEvent } from "./events-sink"

/** Properties a host app may attach to a custom event. */
export type TrackProps = Readonly<Record<string, unknown>>

/**
 * Caps mirroring what the ingest gateway enforces. Applying them here too means
 * an over-sized event is trimmed before it costs bandwidth, and the developer
 * sees the same shape locally that the warehouse will store.
 */
const MAX_NAME_LENGTH = 128
const MAX_PROPS = 32
const MAX_PROP_KEY_LENGTH = 64
const MAX_PROP_VALUE_LENGTH = 1024
const MAX_TOTAL_PROP_BYTES = 8 * 1024

let warnedAboutName = false

/**
 * Coerce one property value to the string the warehouse column holds.
 *
 * `null`/`undefined`/functions/symbols are dropped rather than stringified —
 * `"undefined"` as a stored value is worse than an absent key.
 */
function coerce(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined
	switch (typeof value) {
		case "string":
			return value.slice(0, MAX_PROP_VALUE_LENGTH)
		case "number":
		case "boolean":
		case "bigint":
			return String(value)
		case "function":
		case "symbol":
			return undefined
		default:
			break
	}
	try {
		if (value instanceof Date) return value.toISOString()
		return JSON.stringify(value)?.slice(0, MAX_PROP_VALUE_LENGTH)
	} catch {
		// Circular structure — drop the key rather than throw into the caller.
		return undefined
	}
}

function coerceProps(props: TrackProps | undefined): Record<string, string> {
	if (!props) return {}
	const out: Record<string, string> = {}
	let bytes = 0
	for (const [rawKey, rawValue] of Object.entries(props)) {
		if (Object.keys(out).length >= MAX_PROPS) break
		const value = coerce(rawValue)
		if (value === undefined) continue
		const key = rawKey.slice(0, MAX_PROP_KEY_LENGTH)
		if (!key) continue
		bytes += key.length + value.length
		if (bytes > MAX_TOTAL_PROP_BYTES) break
		out[key] = value
	}
	return out
}

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
		message: name.trim().slice(0, MAX_NAME_LENGTH),
		attrs: coerceProps(props),
		timestamp: Date.now(),
		// Captured now rather than at flush time so a queued event reports the
		// page it actually happened on.
		url: typeof location !== "undefined" ? location.href : undefined,
	}

	const sink = getActiveSink()
	if (sink) sink.emit(ev)
	else queuePending(ev)
}
