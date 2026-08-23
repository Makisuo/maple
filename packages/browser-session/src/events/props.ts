// Property coercion for `track()`, shared by the browser sink and the server
// SDK's product-events client. Pure: no browser globals, so it can be bundled
// into a Node entrypoint without dragging the session engine along.

/** Properties a host app may attach to a custom event. */
export type TrackProps = Readonly<Record<string, unknown>>

/**
 * Caps mirroring what the ingest gateway enforces. Applying them here too means
 * an over-sized event is trimmed before it costs bandwidth, and the developer
 * sees the same shape locally that the warehouse will store.
 */
export const MAX_EVENT_NAME_LENGTH = 128
const MAX_PROPS = 32
const MAX_PROP_KEY_LENGTH = 64
const MAX_PROP_VALUE_LENGTH = 1024
const MAX_TOTAL_PROP_BYTES = 8 * 1024

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

/** Coerce and cap a `track()` property bag to the `Map(String, String)` the warehouse stores. */
export function coerceTrackProps(props: TrackProps | undefined): Record<string, string> {
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
