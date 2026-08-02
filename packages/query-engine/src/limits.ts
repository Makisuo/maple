// ---------------------------------------------------------------------------
// Query time-range limits — single source of truth
//
// These ceilings used to be duplicated as ad-hoc constants across the query
// engine, the MCP tools, and the v2 public API, which drifted: dashboards were
// capped at 7 days by an MCP whitelist while the engine happily served 31, and
// several MCP tools silently clamped results to a week. Everything that bounds
// a time range now reads from here.
//
// Pure — no drivers, no Effect — so this module is safe to re-export from the
// package root barrel and import from the web bundle.
// ---------------------------------------------------------------------------

/** Widest window any query kind may span. */
export const MAX_QUERY_RANGE_SECONDS = 60 * 60 * 24 * 31

/**
 * List queries (recent traces/logs tiles) scan raw rows rather than a rollup,
 * so they carry a much tighter ceiling than charts.
 */
export const MAX_LIST_RANGE_SECONDS = 60 * 60 * 24 * 7

/** Breakdown queries (pie/bar/heatmap/funnel) aggregate across a whole window. */
export const MAX_BREAKDOWN_RANGE_SECONDS = 60 * 60 * 24 * 30

/**
 * A breakdown with no narrowing filter scans the entire partition prefix, so it
 * gets a far tighter ceiling than a filtered one.
 */
export const MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS = 60 * 60 * 24

/** Point budget for a single timeseries response. */
export const MAX_TIMESERIES_POINTS = 1_500

/**
 * Attribute/metric discovery reads pre-aggregated hourly rollups, so it can
 * span wider than the raw-row list cap.
 */
export const MAX_DISCOVERY_RANGE_SECONDS = 60 * 60 * 24 * 30

/** Log-pattern mining clusters raw message bodies — expensive, keep it short. */
export const MAX_LOG_PATTERN_RANGE_SECONDS = 60 * 60 * 24

export type QueryRangeKind = "timeseries" | "list" | "breakdown"

/** The ceiling that applies to a given query kind. */
export function maxRangeSecondsForKind(kind: QueryRangeKind): number {
	switch (kind) {
		case "list":
			return MAX_LIST_RANGE_SECONDS
		case "breakdown":
			return MAX_BREAKDOWN_RANGE_SECONDS
		case "timeseries":
			return MAX_QUERY_RANGE_SECONDS
	}
}

const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24

/**
 * Render a duration as human copy for error messages — "7 days", "24 hours".
 * Keeps every "maximum range is …" string derived from the constants above so
 * changing a limit can never leave stale copy behind.
 */
export function formatRangeSeconds(seconds: number): string {
	if (seconds >= SECONDS_PER_DAY && seconds % SECONDS_PER_DAY === 0) {
		const days = seconds / SECONDS_PER_DAY
		return `${days} day${days === 1 ? "" : "s"}`
	}
	if (seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0) {
		const hours = seconds / SECONDS_PER_HOUR
		return `${hours} hour${hours === 1 ? "" : "s"}`
	}
	const minutes = Math.round(seconds / 60)
	return `${minutes} minute${minutes === 1 ? "" : "s"}`
}

// ---------------------------------------------------------------------------
// Relative range shorthand
//
// The dashboard time picker persists relative ranges as shorthand strings
// ("15m", "24h", "7d", "3mo", "today"). The web app has always been able to
// resolve these; the API could not, which is why the MCP dashboard tools fell
// back to a hardcoded whitelist. Parsing the duration here lets both sides
// validate the same grammar against the same ceilings.
// ---------------------------------------------------------------------------

const RELATIVE_RANGE_PATTERN = /^(\d+)(mo|m|h|d|w)$/

const UNIT_SECONDS: Record<string, number> = {
	m: 60,
	h: SECONDS_PER_HOUR,
	d: SECONDS_PER_DAY,
	w: SECONDS_PER_DAY * 7,
	// Calendar months vary; 30 days is the conventional approximation and is
	// only ever used to compare against a ceiling, never to build query bounds.
	mo: SECONDS_PER_DAY * 30,
}

/**
 * Duration in seconds for a relative range shorthand, or `null` when the string
 * isn't valid shorthand. `"today"` is elapsed-time-dependent and reports its
 * worst case (24h) so validation stays deterministic.
 */
export function relativeRangeSeconds(shorthand: string): number | null {
	const trimmed = shorthand.trim().toLowerCase()
	if (trimmed === "today") return SECONDS_PER_DAY

	const match = RELATIVE_RANGE_PATTERN.exec(trimmed)
	if (!match) return null

	const amount = Number.parseInt(match[1], 10)
	const unitSeconds = UNIT_SECONDS[match[2]]
	if (!Number.isFinite(amount) || amount <= 0 || unitSeconds === undefined) return null

	return amount * unitSeconds
}

export interface RelativeRangeValidation {
	readonly ok: boolean
	/** Populated when `ok` is false — ready to surface to an agent or a user. */
	readonly error?: string
	/** Parsed duration, present whenever the shorthand was well-formed. */
	readonly seconds?: number
}

/**
 * Validate a relative range shorthand against a ceiling. Returns a structured
 * result rather than throwing so MCP tools can turn it straight into an error
 * response — the point of this whole module is that nothing silently downgrades
 * an out-of-range request any more.
 */
export function validateRelativeRange(
	shorthand: string,
	maxSeconds: number = MAX_QUERY_RANGE_SECONDS,
): RelativeRangeValidation {
	const seconds = relativeRangeSeconds(shorthand)
	if (seconds === null) {
		return {
			ok: false,
			error: `Invalid time range "${shorthand}". Use a relative shorthand like "15m", "6h", "7d", "2w", "3mo", or "today".`,
		}
	}

	if (seconds > maxSeconds) {
		return {
			ok: false,
			seconds,
			error: `Time range "${shorthand}" exceeds the maximum supported range of ${formatRangeSeconds(maxSeconds)}.`,
		}
	}

	return { ok: true, seconds }
}
