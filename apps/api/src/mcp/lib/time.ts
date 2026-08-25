import {
	MAX_DISCOVERY_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_LOG_PATTERN_RANGE_SECONDS,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
} from "@maple/query-engine"

// Tool-facing caps, expressed in hours to match `ResolveTimeRangeOptions`. The
// underlying values live in `@maple/query-engine`'s limits module so the MCP
// surface, the v2 API, and the query engine itself can't drift apart.

/** Raw-row search tools (traces, logs, sessions, slow traces, top operations). */
export const MCP_SEARCH_MAX_HOURS = MAX_LIST_RANGE_SECONDS / 3600
/** Rollup-backed discovery tools (metric listing, attribute exploration). */
export const MCP_DISCOVERY_MAX_HOURS = MAX_DISCOVERY_RANGE_SECONDS / 3600
/** Log-pattern clustering — scans raw message bodies. */
export const MCP_LOG_PATTERN_MAX_HOURS = MAX_LOG_PATTERN_RANGE_SECONDS / 3600

/**
 * Normalizes a time string to the `YYYY-MM-DD HH:mm:ss` UTC format expected
 * by Tinybird's `DateTime()` SQL function.
 *
 * Handles ISO 8601 (with T, Z, timezone offsets, milliseconds) and the
 * already-correct `YYYY-MM-DD HH:mm:ss` format — which the shared parser reads
 * as UTC rather than local.
 *
 * Returns `null` when the input isn't a timestamp at all. It used to return the
 * input verbatim, which meant an agent-supplied `'2026-08-47:53'` was spliced
 * into a `DateTime` literal and only failed at ClickHouse, as an unhandled
 * `Cannot parse string … as DateTime`.
 */
export function normalizeTime(input: string): string | null {
	const ms = parseWarehouseDateTime(input.trim())
	return Number.isNaN(ms) ? null : formatWarehouseDateTime(ms)
}

const DEFAULT_HOURS = 6

function defaultTimeRange(hours = DEFAULT_HOURS) {
	const nowMs = Date.now()
	return {
		startTime: formatWarehouseDateTime(nowMs - hours * 3_600_000),
		endTime: formatWarehouseDateTime(nowMs),
	}
}

export interface ResolveTimeRangeOptions {
	/** Default window when the agent supplies neither bound. Defaults to 6h. */
	readonly defaultHours?: number
	/** Maximum allowed window. A wider agent-supplied range is reported as `exceeded`. */
	readonly maxHours?: number
}

/** An agent-supplied bound that wasn't a timestamp, kept for the error message. */
export interface InvalidTimeBound {
	readonly param: "start_time" | "end_time"
	readonly value: string
}

export interface ResolvedTimeRange {
	readonly st: string
	readonly et: string
	/** True when the agent-supplied range is wider than `maxHours`. */
	readonly exceeded: boolean
	/** The `maxHours` cap that applies (if any). Included so callers can surface it. */
	readonly maxHours: number | undefined
	/** Width of the agent-supplied window in hours, when both bounds parsed. */
	readonly requestedHours: number | undefined
	/** Agent-supplied bounds that weren't timestamps. Empty when the range is sound. */
	readonly invalid: ReadonlyArray<InvalidTimeBound>
}

/**
 * Resolves the time range for an MCP tool call.
 * Normalizes user-provided values to UTC and falls back to a default window.
 *
 * When `maxHours` is set and the resolved window is wider, the range is returned
 * *unchanged* with `exceeded: true` — callers must reject it. This used to clamp
 * `st` forward silently, which meant an agent asking for 30 days got 7 and had no
 * way to tell that its answer was computed from a fraction of the window.
 *
 * A bound that isn't a timestamp is reported in `invalid` and replaced by the
 * default window's bound, so `st`/`et` are always a well-formed warehouse
 * DateTime even for a caller that doesn't check. Callers that do check return
 * `timeRangeInvalidResult`, which tells the agent the expected format.
 *
 * Back-compat: the third arg also accepts a bare number (treated as `defaultHours`).
 */
export function resolveTimeRange(
	startTime: string | undefined,
	endTime: string | undefined,
	opts: ResolveTimeRangeOptions | number = {},
): ResolvedTimeRange {
	const { defaultHours = DEFAULT_HOURS, maxHours } =
		typeof opts === "number" ? { defaultHours: opts, maxHours: undefined } : opts

	const defaults = defaultTimeRange(defaultHours)
	const invalid: InvalidTimeBound[] = []

	const resolveBound = (
		supplied: string | undefined,
		param: InvalidTimeBound["param"],
		fallback: string,
	): string => {
		if (supplied === undefined) return fallback
		const normalized = normalizeTime(supplied)
		if (normalized === null) {
			invalid.push({ param, value: supplied })
			return fallback
		}
		return normalized
	}

	const st = resolveBound(startTime, "start_time", defaults.startTime)
	const et = resolveBound(endTime, "end_time", defaults.endTime)

	const stMs = parseWarehouseDateTime(st)
	const etMs = parseWarehouseDateTime(et)
	const requestedHours = Number.isNaN(stMs) || Number.isNaN(etMs) ? undefined : (etMs - stMs) / 3_600_000

	const exceeded =
		invalid.length === 0 &&
		maxHours !== undefined &&
		maxHours > 0 &&
		requestedHours !== undefined &&
		requestedHours > maxHours

	return { st, et, exceeded, maxHours, requestedHours, invalid }
}

const formatHours = (hours: number): string => {
	const rounded = Math.round(hours * 10) / 10
	if (rounded >= 24 && rounded % 24 === 0) {
		const days = rounded / 24
		return `${days} day${days === 1 ? "" : "s"}`
	}
	return `${rounded} hour${rounded === 1 ? "" : "s"}`
}

/**
 * Builds the message for a range that exceeds a tool's cap. Tells the agent what
 * it asked for, what the ceiling is, and what to do instead — so it can retry
 * correctly rather than silently trusting a truncated answer.
 */
export function rangeExceededMessage(
	range: Pick<ResolvedTimeRange, "maxHours" | "requestedHours">,
	toolName: string,
): string {
	const cap = range.maxHours === undefined ? "the supported range" : formatHours(range.maxHours)
	const requested = range.requestedHours === undefined ? undefined : formatHours(range.requestedHours)
	return [
		`Time range too large for \`${toolName}\`.`,
		requested === undefined
			? `Maximum supported range is ${cap}.`
			: `Requested ${requested}, maximum supported range is ${cap}.`,
		`Narrow start_time/end_time to ${cap} or less. For wider trends use \`query_data\` with a timeseries query, which aggregates instead of scanning raw rows.`,
	].join(" ")
}

/**
 * Standard MCP error result for an over-wide range. Returned directly by tools.
 */
export function rangeExceededResult(
	range: Pick<ResolvedTimeRange, "maxHours" | "requestedHours">,
	toolName: string,
) {
	return {
		content: [{ type: "text" as const, text: rangeExceededMessage(range, toolName) }],
		isError: true as const,
	}
}

/**
 * Builds the message for bounds that aren't timestamps. Names each bad value so
 * the agent can see what it actually sent, and states the accepted formats.
 */
export function timeRangeInvalidMessage(range: Pick<ResolvedTimeRange, "invalid">, toolName: string): string {
	const bounds = range.invalid.map((b) => `${b.param}="${b.value}"`).join(" and ")
	return [
		`Invalid time value for \`${toolName}\`: ${bounds}.`,
		`Use \`YYYY-MM-DD HH:mm:ss\` (UTC) or an ISO-8601 timestamp, or omit the bound to use the default window.`,
	].join(" ")
}

/**
 * Standard MCP error result for unparseable bounds. Returned directly by tools,
 * so a malformed timestamp fails as a retryable tool error rather than as a
 * ClickHouse parse error the agent can't act on.
 */
export function timeRangeInvalidResult(range: Pick<ResolvedTimeRange, "invalid">, toolName: string) {
	return {
		content: [{ type: "text" as const, text: timeRangeInvalidMessage(range, toolName) }],
		isError: true as const,
	}
}
