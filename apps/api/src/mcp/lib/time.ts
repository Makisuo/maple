import * as DateTime from "effect/DateTime"
import { Option } from "effect"
import {
	MAX_DISCOVERY_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_LOG_PATTERN_RANGE_SECONDS,
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

const formatUtc = (dt: DateTime.DateTime): string => DateTime.formatIso(dt).replace("T", " ").slice(0, 19)

const alreadyNormalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * Normalizes a time string to the `YYYY-MM-DD HH:mm:ss` UTC format expected
 * by Tinybird's `DateTime()` SQL function.
 *
 * Handles ISO 8601 (with T, Z, timezone offsets, milliseconds) and the
 * already-correct `YYYY-MM-DD HH:mm:ss` format. Returns the original string
 * unchanged if parsing fails.
 */
export function normalizeTime(input: string): string {
	const trimmed = input.trim()
	if (alreadyNormalized.test(trimmed)) return trimmed

	const parsed = DateTime.make(trimmed)
	if (Option.isSome(parsed)) return formatUtc(parsed.value)

	return trimmed
}

const DEFAULT_HOURS = 6

function defaultTimeRange(hours = DEFAULT_HOURS) {
	const now = DateTime.nowUnsafe()
	const start = DateTime.subtract(now, { hours })
	return {
		startTime: formatUtc(start),
		endTime: formatUtc(now),
	}
}

const NORMALIZED_UTC = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

function toEpochMs(normalized: string): number | undefined {
	const m = NORMALIZED_UTC.exec(normalized)
	if (!m) return undefined
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

function fromEpochMs(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
}

export interface ResolveTimeRangeOptions {
	/** Default window when the agent supplies neither bound. Defaults to 6h. */
	readonly defaultHours?: number
	/** Maximum allowed window. A wider agent-supplied range is reported as `exceeded`. */
	readonly maxHours?: number
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
	const st = startTime ? normalizeTime(startTime) : defaults.startTime
	const et = endTime ? normalizeTime(endTime) : defaults.endTime

	const stMs = toEpochMs(st)
	const etMs = toEpochMs(et)
	const requestedHours =
		stMs !== undefined && etMs !== undefined ? (etMs - stMs) / (3600 * 1000) : undefined

	const exceeded =
		maxHours !== undefined && maxHours > 0 && requestedHours !== undefined && requestedHours > maxHours

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
