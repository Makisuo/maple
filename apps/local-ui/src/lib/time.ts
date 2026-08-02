// Time helpers for the local query layer.
//
// The CH query builders accept `startTime` / `endTime` as ClickHouse DateTime
// strings (`'YYYY-MM-DD HH:MM:SS'`); `resolveParam` quotes them inline. chDB
// parses the quoted string into a DateTime for the partition-pruning filters.

import { formatRelativeFrom } from "@maple/ui/time-format"

import { formatWarehouseDateTime } from "@maple/query-engine"
/** Format an epoch-ms instant as a ClickHouse DateTime string (UTC, second precision). */
export function toClickHouseDateTime(epochMs: number): string {
	return formatWarehouseDateTime(epochMs)
}

export interface TimeBounds {
	startTime: string
	endTime: string
}

// ---------------------------------------------------------------------------
// Time-range presets — drive the segmented range control in the filter bar.
// ---------------------------------------------------------------------------

export interface TimeRange {
	readonly key: string
	readonly label: string
	readonly minutes: number
}

export const TIME_RANGES: ReadonlyArray<TimeRange> = [
	{ key: "1h", label: "1H", minutes: 60 },
	{ key: "6h", label: "6H", minutes: 6 * 60 },
	{ key: "24h", label: "24H", minutes: 24 * 60 },
	{ key: "7d", label: "7D", minutes: 7 * 24 * 60 },
	{ key: "30d", label: "30D", minutes: 30 * 24 * 60 },
]

/** Default look-back. Mirrors the original 30-day window so behavior is unchanged until a user narrows it. */
export const DEFAULT_RANGE = "30d"

/** Resolve a range key to ClickHouse DateTime bounds, padding the upper bound for clock skew. */
export function boundsForRange(key: string | undefined): TimeBounds {
	const range = TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[TIME_RANGES.length - 1]
	const now = Date.now()
	return {
		startTime: toClickHouseDateTime(now - range.minutes * 60 * 1000),
		endTime: toClickHouseDateTime(now + 60 * 60 * 1000),
	}
}

/**
 * Parse a chDB UTC datetime string (`'YYYY-MM-DD HH:MM:SS'`, no timezone
 * marker) to epoch-ms. Returns `null` for empty/invalid input or the zero date
 * chDB emits for an empty aggregate.
 */
export function parseClickHouseDateTime(chDateTime: string | null | undefined): number | null {
	if (!chDateTime) return null
	const ms = Date.parse(`${chDateTime.replace(" ", "T")}Z`)
	if (Number.isNaN(ms) || ms <= 0) return null
	return ms
}

/**
 * Compact relative-time label from a ClickHouse DateTime string. Keeps the
 * chDB null/zero-date guard, then defers to the shared relative-time ladder.
 */
export function formatRelativeTime(chDateTime: string | null | undefined): string {
	const ms = parseClickHouseDateTime(chDateTime)
	return ms === null ? "—" : formatRelativeFrom(ms)
}
