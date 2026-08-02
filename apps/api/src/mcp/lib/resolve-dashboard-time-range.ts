import * as DateTime from "effect/DateTime"
import { MAX_QUERY_RANGE_SECONDS, validateRelativeRange } from "@maple/query-engine"

const formatUtc = (dt: DateTime.DateTime): string => DateTime.formatIso(dt).replace("T", " ").slice(0, 19)

const RELATIVE_PATTERN = /^(\d+)(mo|m|h|d|w)$/

type RelativeUnit = "m" | "h" | "d" | "w" | "mo"

const subtractRelative = (now: DateTime.DateTime, amount: number, unit: RelativeUnit): DateTime.DateTime => {
	switch (unit) {
		case "m":
			return DateTime.subtract(now, { minutes: amount })
		case "h":
			return DateTime.subtract(now, { hours: amount })
		case "d":
			return DateTime.subtract(now, { days: amount })
		case "w":
			return DateTime.subtract(now, { weeks: amount })
		case "mo":
			return DateTime.subtract(now, { days: amount * 30 })
	}
}

export interface ResolvedTimeRange {
	startTime: string
	endTime: string
}

/**
 * Validates an agent-supplied dashboard `time_range` shorthand.
 *
 * `create_dashboard` used to run this value through a `{1h, 6h, 24h, 7d}`
 * whitelist and silently fall back to "1h" for anything else — so asking for a
 * 30-day board produced a 1-hour one with no indication anything had changed.
 * Now anything the picker can express is accepted up to the engine's real
 * ceiling, and everything else is an explicit error.
 *
 * Returns `null` when the value is valid, or an error message to return to the
 * agent when it is not.
 */
export function validateDashboardTimeRange(value: string): string | null {
	const result = validateRelativeRange(value, MAX_QUERY_RANGE_SECONDS)
	return result.ok ? null : (result.error ?? `Invalid time range "${value}".`)
}

export type DashboardTimeRangeInput =
	| { type: "relative"; value: string }
	| { type: "absolute"; startTime: string; endTime: string }

/**
 * Resolves a dashboard `timeRange` (relative shorthand like "24h" or absolute
 * ISO timestamps) into Tinybird's `YYYY-MM-DD HH:mm:ss` UTC format.
 *
 * Returns `null` for unrecognized relative shorthands so the caller can fall
 * back to a sensible default window.
 */
export function resolveDashboardTimeRange(timeRange: DashboardTimeRangeInput): ResolvedTimeRange | null {
	if (timeRange.type === "absolute") {
		const start = DateTime.make(timeRange.startTime)
		const end = DateTime.make(timeRange.endTime)
		if (start._tag === "None" || end._tag === "None") return null
		return {
			startTime: formatUtc(start.value),
			endTime: formatUtc(end.value),
		}
	}

	const trimmed = timeRange.value.trim().toLowerCase()
	if (!trimmed) return null

	// The time picker can persist "today"; without this the API resolved those
	// dashboards to null and silently fell back to a default window.
	if (trimmed === "today") {
		const now = DateTime.nowUnsafe()
		return {
			startTime: formatUtc(DateTime.startOf(now, "day")),
			endTime: formatUtc(now),
		}
	}

	const match = trimmed.match(RELATIVE_PATTERN)
	if (!match) return null

	const amount = Number.parseInt(match[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) return null

	const unit = match[2] as RelativeUnit
	const now = DateTime.nowUnsafe()
	const start = subtractRelative(now, amount, unit)

	return {
		startTime: formatUtc(start),
		endTime: formatUtc(now),
	}
}
