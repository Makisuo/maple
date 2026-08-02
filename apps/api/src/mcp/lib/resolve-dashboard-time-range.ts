import {
	MAX_QUERY_RANGE_SECONDS,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	resolveRelativeRangeToWarehouse,
	validateRelativeRange,
} from "@maple/query-engine"

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
		// `parseWarehouseDateTime`, not `Date.parse`: a stored bound may be the
		// tz-less `YYYY-MM-DD HH:MM:SS` shape, which `Date.parse` reads as local
		// time and silently shifts by the runtime's UTC offset.
		const startMs = parseWarehouseDateTime(timeRange.startTime)
		const endMs = parseWarehouseDateTime(timeRange.endTime)
		if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
		return {
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
		}
	}

	// Relative shorthand — including "today" — is resolved by the shared grammar,
	// so this no longer approximates a month as 30 days the way it used to.
	return resolveRelativeRangeToWarehouse(timeRange.value)
}
