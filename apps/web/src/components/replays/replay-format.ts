import { warehouseDateTimeToIso } from "@maple/query-engine"
import type { ActionKind } from "./replay-player-context"

// Shared presentation helpers for the session-replay surfaces (list, detail,
// player, timeline). One home so the list and detail views can't drift.

/** `1m 23s` / `45s`, or `—` for missing/zero durations. */
export function formatDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Playhead clock `m:ss`. Clamps non-finite/negative input to 0. */
export function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

/** Host + path for compact URL display; returns the raw input if unparseable. */
export function hostFromUrl(url: string): string {
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
	} catch {
		return url
	}
}

const AVATAR_GRADIENTS = [
	"from-rose-500/80 to-orange-400/80",
	"from-violet-500/80 to-fuchsia-400/80",
	"from-sky-500/80 to-cyan-400/80",
	"from-emerald-500/80 to-teal-400/80",
	"from-amber-500/80 to-yellow-400/80",
	"from-indigo-500/80 to-blue-400/80",
]

/** Deterministic avatar gradient for a session, keyed by a stable seed. */
export function gradientFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!
}

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

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
	["second", 1000],
]

const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

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

/** A warehouse partition-pruning window, shared by the session-detail atom callers. */
export interface ReplayPartitionWindow {
	readonly windowStart: string
	readonly windowEnd: string
}

/** Format an epoch-ms instant as a `YYYY-MM-DD HH:mm:ss` (UTC) TinybirdDateTime string. */
const toWarehouseDateTime = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19)

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
		windowStart: toWarehouseDateTime(startMs - WINDOW_MARGIN_MS),
		windowEnd: toWarehouseDateTime(upperMs),
	}
}

/** `2h ago` / `just now` for an epoch-ms instant, relative to `nowMs` (defaults to Date.now()). */
export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
	if (!Number.isFinite(epochMs)) return "—"
	const deltaMs = epochMs - nowMs
	const abs = Math.abs(deltaMs)
	if (abs < 5_000) return "just now"
	for (const [unit, ms] of RELATIVE_UNITS) {
		if (abs >= ms) return relativeFmt.format(Math.round(deltaMs / ms), unit)
	}
	return "just now"
}
