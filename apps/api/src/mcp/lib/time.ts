import {
	MAX_DISCOVERY_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_LOG_PATTERN_RANGE_SECONDS,
	parseWarehouseDateTime,
	warehouseDateTime,
	type WarehouseDateTime,
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

const DEFAULT_HOURS = 6

function defaultTimeRange(hours = DEFAULT_HOURS) {
	const nowMs = Date.now()
	return {
		startTime: warehouseDateTime(nowMs - hours * 3_600_000),
		endTime: warehouseDateTime(nowMs),
	}
}

export interface ResolveTimeRangeOptions {
	/** Default window when the agent supplies neither bound. Defaults to 6h. */
	readonly defaultHours?: number
	/** Maximum allowed window. A wider agent-supplied range is reported as `exceeded`. */
	readonly maxHours?: number
}

export interface ResolvedTimeRange {
	readonly st: WarehouseDateTime
	readonly et: WarehouseDateTime
	/** True when the agent-supplied range is wider than `maxHours`. */
	readonly exceeded: boolean
	/** The `maxHours` cap that applies (if any). Included so callers can surface it. */
	readonly maxHours: number | undefined
	/** Width of the resolved window in hours. */
	readonly requestedHours: number
}

/**
 * Resolves the time range for an MCP tool call, falling back to a default window
 * for bounds the agent didn't supply.
 *
 * Both bounds are {@link WarehouseDateTime}, so this function has no parsing to
 * do and no malformed case to handle: `optionalTimeParam` decoded and
 * canonicalized them at the tool's parameter boundary, or the call didn't
 * typecheck. That is the whole reason the brand exists — a tool cannot reach
 * this function with a raw string it forgot to validate.
 *
 * When `maxHours` is set and the resolved window is wider, the range is returned
 * *unchanged* with `exceeded: true` — callers must reject it. This used to clamp
 * `st` forward silently, which meant an agent asking for 30 days got 7 and had no
 * way to tell that its answer was computed from a fraction of the window.
 *
 * Back-compat: the third arg also accepts a bare number (treated as `defaultHours`).
 */
export function resolveTimeRange(
	startTime: WarehouseDateTime | undefined,
	endTime: WarehouseDateTime | undefined,
	opts: ResolveTimeRangeOptions | number = {},
): ResolvedTimeRange {
	const { defaultHours = DEFAULT_HOURS, maxHours } =
		typeof opts === "number" ? { defaultHours: opts, maxHours: undefined } : opts

	const defaults = defaultTimeRange(defaultHours)
	const st = startTime ?? defaults.startTime
	const et = endTime ?? defaults.endTime

	const requestedHours = (parseWarehouseDateTime(et) - parseWarehouseDateTime(st)) / 3_600_000

	const exceeded = maxHours !== undefined && maxHours > 0 && requestedHours > maxHours

	return { st, et, exceeded, maxHours, requestedHours }
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
	return [
		`Time range too large for \`${toolName}\`.`,
		`Requested ${formatHours(range.requestedHours)}, maximum supported range is ${cap}.`,
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
