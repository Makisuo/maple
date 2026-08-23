import { formatWarehouseDateTime } from "@maple/query-engine"
import { toEpochMs } from "@maple/ui/lib/time-format"

// Slack, not compensation: the list now reports each session's own bounds
// rather than clamping them to the list page's time range, so the hints already
// contain the session. What is left to absorb is rounding — a warehouse window
// is rendered at whole-second precision, which floors an exact `end` below the
// final span's sub-second timestamp — and the clock skew between the services
// one trace crosses.
const WINDOW_PADDING_MS = 60_000

/** Deep link with no usable start hint: look back far enough to find most
 *  sessions, and accept the slower read that comes with it. */
const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionWindow {
	readonly startTime: string
	readonly endTime: string
}

/**
 * The warehouse window for one session, from the `t`/`end` hints the list row
 * carried. The two hints are validated independently: an unusable `end` degrades
 * to the start-only window rather than discarding a good `t`.
 */
export function resolveWindow(t: string | undefined, end: string | undefined, nowMs: number): SessionWindow {
	const startHint = t === undefined ? Number.NaN : toEpochMs(t)
	if (Number.isNaN(startHint)) {
		return {
			startTime: formatWarehouseDateTime(nowMs - FALLBACK_WINDOW_MS),
			endTime: formatWarehouseDateTime(nowMs),
		}
	}

	// A link carrying only `t` (copied from a trace, say) still narrows the read:
	// the session started there, so pad around that instant alone.
	const endHint = end === undefined ? Number.NaN : toEpochMs(end)
	const endMs = Number.isNaN(endHint) ? startHint : endHint

	return {
		startTime: formatWarehouseDateTime(startHint - WINDOW_PADDING_MS),
		endTime: formatWarehouseDateTime(endMs + WINDOW_PADDING_MS),
	}
}

/** Everything but the detail page's own params, so Back lands on the list the
 *  reader left — same time range, same filters. Mirrors `buildBackToTracesHref`
 *  in traces/$traceId, including reading the raw `searchStr`: the list owns its
 *  search schema, and re-encoding it through the detail route's would drop it. */
export function buildBackToSessionsHref(searchStr: string): string {
	const params = new URLSearchParams(searchStr)
	params.delete("t")
	params.delete("end")
	params.delete("trace")
	params.delete("span")
	const nextSearch = params.toString()
	return nextSearch ? `/agent-sessions?${nextSearch}` : "/agent-sessions"
}

/** Session ids belong to the framework that wrote them, and the long ones carry
 *  their entropy at both ends — `slice(0, 8)` of a `wrun_01KZ…` id renders the
 *  word "wrun_01K", which identifies nothing. */
const BREADCRUMB_ID_MAX_CHARS = 24

export function breadcrumbSessionId(sessionId: string): string {
	if (sessionId.length <= BREADCRUMB_ID_MAX_CHARS) return sessionId
	return `${sessionId.slice(0, 9)}…${sessionId.slice(-4)}`
}
