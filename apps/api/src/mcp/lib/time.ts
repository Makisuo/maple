import * as DateTime from "effect/DateTime"
import { Option } from "effect"

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
	/** Maximum allowed window. If the agent-supplied range exceeds it, startTime is clamped. */
	readonly maxHours?: number
}

export interface ResolvedTimeRange {
	readonly st: string
	readonly et: string
	/** True when the agent-supplied range was clamped down to `maxHours`. */
	readonly clamped: boolean
	/** The `maxHours` cap that was applied (if any). Included so callers can surface it. */
	readonly maxHours: number | undefined
}

/**
 * Resolves the time range for an MCP tool call.
 * Normalizes user-provided values to UTC and falls back to a default window.
 * When `maxHours` is set and the resolved window exceeds it, clamps `st` to
 * `et - maxHours` and flags `clamped: true` so callers can note it in the response.
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
	let st = startTime ? normalizeTime(startTime) : defaults.startTime
	let et = endTime ? normalizeTime(endTime) : defaults.endTime

	let clamped = false
	if (maxHours !== undefined && maxHours > 0) {
		const stMs = toEpochMs(st)
		const etMs = toEpochMs(et)
		if (stMs !== undefined && etMs !== undefined) {
			const maxMs = maxHours * 3600 * 1000
			if (etMs - stMs > maxMs) {
				st = fromEpochMs(etMs - maxMs)
				clamped = true
			}
		}
	}

	return { st, et, clamped, maxHours }
}

/**
 * Builds a short "(range clamped to N days / N hours)" note for inclusion in
 * tool response headers. Returns an empty string when nothing was clamped.
 */
export function formatClampNote(range: Pick<ResolvedTimeRange, "clamped" | "maxHours">): string {
	if (!range.clamped || range.maxHours === undefined) return ""
	const h = range.maxHours
	const unit =
		h >= 24 && h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hour${h === 1 ? "" : "s"}`
	return ` (range clamped to ${unit})`
}
