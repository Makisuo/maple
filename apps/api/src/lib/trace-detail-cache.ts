import { parseWarehouseDateTime } from "@maple/query-engine"

// Trace spans are immutable once a trace has finished — only recently-ended
// traces can still receive late-arriving spans. Traces whose query window
// ended a while ago can therefore be edge-cached far longer than the 15s
// `cachedDirect` default. Without a window the age is unknown until the probe
// runs inside the cache-miss effect, so use a conservative middle ground.
const TRACE_TTL_SETTLED_SECONDS = 600
const TRACE_TTL_LIVE_SECONDS = 15
const TRACE_TTL_UNKNOWN_SECONDS = 60
const TRACE_SETTLED_AFTER_MS = 15 * 60_000

export const traceCacheTtlSeconds = (endTime: string | undefined, nowMs: number): number => {
	if (endTime == null) return TRACE_TTL_UNKNOWN_SECONDS
	const endMs = parseWarehouseDateTime(endTime)
	if (Number.isNaN(endMs)) return TRACE_TTL_LIVE_SECONDS
	return nowMs - endMs > TRACE_SETTLED_AFTER_MS ? TRACE_TTL_SETTLED_SECONDS : TRACE_TTL_LIVE_SECONDS
}
