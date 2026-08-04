/**
 * Deterministic stringification for cache keys.
 *
 * Every cache key that embeds a query object has to survive the same hazard:
 * two semantically identical `QuerySpec`s built by different producers (the
 * dashboard builder, a saved template, the MCP widget tools, alerting) carry
 * their keys in different insertion order, and `JSON.stringify` preserves that
 * order. Hashing the raw output therefore mints a fresh cache entry for a query
 * the cache already holds — a silent, unattributable hit-rate loss.
 *
 * Lives at the package root rather than inside `caching/` so the `runtime`
 * key builders can share it without `runtime` depending on `caching`. Pure —
 * safe for the driver-free root barrel.
 */

/**
 * Recursively sort object keys and drop `undefined`. Arrays preserve order —
 * element order is meaningful in a `QuerySpec` (an ORDER BY list is not a set),
 * so callers that know a given field is set-like must normalize it themselves.
 * Non-serializable values are coerced with `String(...)`; cycles collapse to
 * `null` so a malformed input can never hang the key path.
 */
export const canonicalJSON = (value: unknown): string => {
	const seen = new WeakSet<object>()
	const walk = (v: unknown): unknown => {
		if (v === null) return null
		if (v === undefined) return undefined
		const t = typeof v
		if (t === "string" || t === "number" || t === "boolean") return v
		if (t === "bigint") return v.toString()
		if (Array.isArray(v)) {
			return v.map((item) => walk(item))
		}
		if (t === "object") {
			if (seen.has(v as object)) return null
			seen.add(v as object)
			const entries = Object.entries(v as Record<string, unknown>)
				.filter(([, nested]) => nested !== undefined)
				.map(([key, nested]) => [key, walk(nested)] as const)
				.sort(([a], [b]) => a.localeCompare(b))
			return Object.fromEntries(entries)
		}
		return String(v)
	}
	return JSON.stringify(walk(value))
}
