import { getServiceColor } from "@maple/ui/lib/colors"

// ---------------------------------------------------------------------------
// Agent trace-local formatters.
//
// Deliberately NOT `@maple/ui/lib/format`. An agent trace is read as a transcript,
// so the whole surface leans on two shapes the shared helpers don't produce:
//
// - clock-shaped wall time (`3m 12s`, `41m 08s`) for the agent trace and for the
//   `+m:ss` offsets down the spine — `formatDuration` would render `3.2min`,
//   which can't be compared against a timestamp;
// - one-decimal seconds (`2.1s`, `0.3s`) for a single turn or tool call, where
//   `formatDuration`'s `2.10s` / `340.0ms` mixes units inside one column.
//
// `replay-format.ts` split off from the shared formatters for exactly this
// reason and documents why sharing the *name* was the mistake — these are
// `formatAgentTrace*` / `formatTurn*` for the same reason.
// ---------------------------------------------------------------------------

/** Wall-clock span of an agent trace or a collapsed run of turns: `57s`, `3m 12s`, `1h 04m`. */
export function formatAgentTraceDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	if (totalSeconds < 60) return `${totalSeconds}s`
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** One event's own duration: `0.3s`, `2.1s`, `12.4s`, `4m 12s` past a minute. */
export function formatTurnDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return formatAgentTraceDuration(ms)
}

/** Offset from the agent trace's first event, as it appears down the spine: `+0:00`, `+11:20`. */
export function formatAgentTraceOffset(ms: number): string {
	const clamped = Math.max(0, Math.round(ms / 1000))
	const minutes = Math.floor(clamped / 60)
	const seconds = clamped % 60
	return `+${minutes}:${String(seconds).padStart(2, "0")}`
}

/** Full-precision token count — token totals are read, not scanned: `18,412`. */
export function formatTokens(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—"
	return Math.round(value).toLocaleString()
}

/** Compact token count for inside a badge, where the exact figure isn't the point: `8.2k`. */
export function formatTokensCompact(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—"
	const abs = Math.abs(value)
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
	return String(Math.round(value))
}

/**
 * Dollars, at the precision the figure deserves. Returns `null` for a null
 * cost so callers omit the stat: most emitters send no cost attribute at all,
 * and `$0.00` is a claim we can't make.
 */
export function formatCost(value: number | null | undefined): string | null {
	if (value == null || !Number.isFinite(value)) return null
	if (value === 0) return "$0"
	if (value < 0.01) return `$${value.toFixed(4)}`
	if (value < 10) return `$${value.toFixed(3)}`
	return `$${value.toFixed(2)}`
}

/** `14:06:22` — the wall-clock start, in the viewer's locale. */
export function formatClockTime(timestamp: string | null | undefined): string | null {
	const ms = parseWarehouseTimestamp(timestamp)
	if (ms == null) return null
	return new Date(ms).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	})
}

/**
 * Warehouse timestamps arrive as `YYYY-MM-DD HH:MM:SS[.mmm]` in UTC with no
 * zone marker. `Date.parse` reads that as *local* time on every engine that
 * accepts it at all, which slides every offset on the page by the viewer's UTC
 * offset — so normalise to ISO-with-Z before parsing.
 */
export function parseWarehouseTimestamp(value: string | null | undefined): number | null {
	if (!value) return null
	const normalised = value.includes("T") ? value : value.replace(" ", "T")
	const zoned = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`
	const ms = Date.parse(zoned)
	return Number.isFinite(ms) ? ms : null
}

/**
 * An agent's colour, hashed from its name so one agent keeps the same swatch in
 * the spine, the handoff bars, the agent trace map and the rail — and the same
 * swatch it would get anywhere else in the product. Falls back to the muted
 * foreground for events that carry no agent at all.
 */
export function agentColor(agentName: string | null | undefined): string {
	if (!agentName) return "var(--muted-foreground)"
	return getServiceColor(agentName)
}

/** `stop` → `stop`; `tool_calls` → `tool calls`. Finish reasons are snake_case on the wire. */
export function humaniseFinishReason(reason: string): string {
	return reason.replace(/_/g, " ")
}

/** Rough word count for the system prompt's length hint. */
export function countWords(text: string): number {
	const trimmed = text.trim()
	if (trimmed.length === 0) return 0
	return trimmed.split(/\s+/).length
}

/** Pretty-print a JSON payload, leaving non-JSON strings (and huge blobs) alone. */
export function formatJsonPayload(raw: string): string {
	if (raw.length > 200_000) return raw
	try {
		return JSON.stringify(JSON.parse(raw), null, 2)
	} catch {
		return raw
	}
}

/**
 * The one-line preview of a tool's arguments that sits beside its name in the
 * table — `{ batch_id: "pb_2026_03" }`. Long collections collapse to `[ …12 ]`
 * rather than truncating mid-token, because a cut-off array reads as corrupt.
 */
export function summariseToolArguments(raw: string | null): string | null {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return raw.length > 72 ? `${raw.slice(0, 71)}…` : raw
	}
	return summariseValue(parsed, 0)
}

function summariseValue(value: unknown, depth: number): string {
	if (value === null) return "null"
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]"
		if (depth > 0 || value.length > 3) return `[ …${value.length} ]`
		return `[ ${value.map((item) => summariseValue(item, depth + 1)).join(", ")} ]`
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
		if (entries.length === 0) return "{}"
		if (depth > 0) return `{ …${entries.length} }`
		const shown = entries
			.slice(0, 3)
			.map(([key, item]) => `${key}: ${summariseValue(item, depth + 1)}`)
			.join(", ")
		return entries.length > 3 ? `{ ${shown}, … }` : `{ ${shown} }`
	}
	if (typeof value === "string") return value.length > 32 ? `"${value.slice(0, 31)}…"` : `"${value}"`
	return String(value)
}
