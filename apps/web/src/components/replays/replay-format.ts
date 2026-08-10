import { warehouseDateTimeToIso, formatWarehouseDateTime } from "@maple/query-engine"
import type { ActionKind } from "./replay-player-context"

// Presentation helpers for the session-replay surfaces (list, detail, player,
// timeline). The pure formatters are promoted to @maple/ui (shared with the
// local-mode UI); the warehouse-coupled window helper stays here.

export { formatClock, formatSessionDuration, gradientFor, hostFromUrl } from "@maple/ui/lib/replay-format"

/** Marker dot colour by action kind, shared by the player and timeline tracks. */
export const MARKER_STYLES: Record<ActionKind, string> = {
	click: "bg-amber-400",
	input: "bg-sky-400",
	scroll: "bg-violet-400",
	nav: "bg-emerald-400",
}

/** Human label per action kind, paired with `MARKER_STYLES` for the shared legend. */
export const MARKER_LABELS: Record<ActionKind, string> = {
	click: "Click",
	input: "Input",
	scroll: "Scroll",
	nav: "Navigate",
}

// Partition-pruning window for the session-detail warehouse queries. The replay
// tables are PARTITION BY toDate(...) over a 30-day TTL, so a query filtered only
// by (OrgId, SessionId/TraceId) scans the index of every daily partition. Bounding
// it to the session's span prunes to the 1-2 partitions that actually hold the rows.
const WINDOW_MARGIN_MS = 60 * 60 * 1000 // 1h slack on each side (clock skew, late spans)
// Upper bound when the session end is unknown (still active). This MUST stay >=
// the browser SDK's session lifetime cap (`MAX_SESSION_MS` in
// packages/browser-session/src/session.ts) — the SDK rotates to a fresh session once it
// exceeds that age, so a session's events provably can't extend past
// `start + cap`. Both constants are 24h. If the SDK cap is ever raised without
// raising this one, this window would silently prune out a session's tail events
// (no failing test would catch it), so keep them in lockstep.
const MAX_SESSION_MS = 24 * 60 * 60 * 1000

/**
 * Read the SDK's `maple.session.recorded` marker out of a session's
 * JSON-encoded resource attributes (`session_replays.ResourceAttributes`).
 *
 * Returns `undefined` when the marker is absent — sessions written before the
 * SDK stamped it, and any row whose attributes fail to parse. Callers must
 * treat that as "unknown", not "not recorded", and fall back to the session
 * status + chunk count.
 */
export function recordedMarker(resourceAttributes: string | null | undefined): boolean | undefined {
	if (!resourceAttributes) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(resourceAttributes)
	} catch {
		return undefined
	}
	if (typeof parsed !== "object" || parsed === null) return undefined
	const marker = (parsed as Record<string, unknown>)["maple.session.recorded"]
	if (marker === "true") return true
	if (marker === "false") return false
	return undefined
}

/** A warehouse partition-pruning window, shared by the session-detail atom callers. */
export interface ReplayPartitionWindow {
	readonly windowStart: string
	readonly windowEnd: string
}

/** Format an epoch-ms instant as a `YYYY-MM-DD HH:mm:ss` (UTC) TinybirdDateTime string. */

/**
 * Derive `{ windowStart, windowEnd }` (TinybirdDateTime strings) bounding a
 * session, from its start (and optional end) warehouse timestamps. Returns
 * `undefined` when the start hint is missing/unparseable — callers then omit the
 * window and the query falls back to a full scan (deep-link path, no regression).
 */
export function replayPartitionWindow(
	startHint: string | null | undefined,
	endHint?: string | null,
): ReplayPartitionWindow | undefined {
	if (!startHint) return undefined
	const startMs = Date.parse(warehouseDateTimeToIso(startHint))
	if (Number.isNaN(startMs)) return undefined
	const endMs = endHint ? Date.parse(warehouseDateTimeToIso(endHint)) : Number.NaN
	const upperMs = Number.isNaN(endMs) ? startMs + MAX_SESSION_MS : endMs + WINDOW_MARGIN_MS
	return {
		windowStart: formatWarehouseDateTime(startMs - WINDOW_MARGIN_MS),
		windowEnd: formatWarehouseDateTime(upperMs),
	}
}
