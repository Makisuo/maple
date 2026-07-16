import { subMinutes, subHours, subDays, subWeeks, subMonths, startOfDay } from "date-fns"
import { TZDate } from "@date-fns/tz"
import { formatDateTime, type TimeZoneId } from "@maple/ui/lib/time-format"
import { normalizeTimestampInput } from "@/lib/timezone-format"

// Format date for Tinybird/ClickHouse DateTime compatibility
// Converts to ClickHouse format: "YYYY-MM-DD HH:mm:ss"
export function formatForTinybird(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19)
}

export interface TimePreset {
	label: string
	value: string
	getRange: () => { startTime: string; endTime: string }
}

export interface QuickSelectOption {
	label: string
	value: string
}

const TIME_UNITS: Record<string, (date: Date, amount: number) => Date> = {
	m: subMinutes,
	h: subHours,
	d: subDays,
	w: subWeeks,
	mo: subMonths,
}

/**
 * Midnight that starts "today" — in `timeZone` when given (via `TZDate` on the
 * zone's calendar day), otherwise the browser-local day (unchanged legacy path).
 */
function startOfToday(now: Date, timeZone?: TimeZoneId): Date {
	if (!timeZone) return startOfDay(now)
	const zonedNow = new TZDate(now.getTime(), timeZone)
	const midnight = new TZDate(zonedNow.getFullYear(), zonedNow.getMonth(), zonedNow.getDate(), 0, 0, 0, timeZone)
	return new Date(midnight.getTime())
}

export function relativeToAbsolute(
	shorthand: string,
	timeZone?: TimeZoneId,
): { startTime: string; endTime: string } | null {
	const trimmed = shorthand.trim().toLowerCase()
	const now = new Date()

	if (trimmed === "today") {
		return {
			startTime: formatForTinybird(startOfToday(now, timeZone)),
			endTime: formatForTinybird(now),
		}
	}

	const match = trimmed.match(/^(\d+)(mo|m|h|d|w)$/)
	if (!match) return null

	const [, amountStr, unit] = match
	const amount = parseInt(amountStr, 10)

	const subtractor = TIME_UNITS[unit]
	if (!subtractor) return null

	return {
		startTime: formatForTinybird(subtractor(now, amount)),
		endTime: formatForTinybird(now),
	}
}

export function presetLabel(shorthand: string): string {
	// Check PRESET_OPTIONS first for exact match
	const preset = PRESET_OPTIONS.find((p) => p.value === shorthand)
	if (preset) return preset.label

	// Generate dynamically
	const trimmed = shorthand.trim().toLowerCase()
	if (trimmed === "today") return "Today"

	const match = trimmed.match(/^(\d+)(mo|m|h|d|w)$/)
	if (!match) return shorthand

	const [, amountStr, unit] = match
	const amount = parseInt(amountStr, 10)

	const unitLabels: Record<string, [string, string]> = {
		m: ["minute", "minutes"],
		h: ["hour", "hours"],
		d: ["day", "days"],
		w: ["week", "weeks"],
		mo: ["month", "months"],
	}

	const [singular, plural] = unitLabels[unit] ?? [unit, unit]
	return `Last ${amount} ${amount === 1 ? singular : plural}`
}

export function formatTimeRangeDisplay(
	startTime: string | undefined,
	endTime: string | undefined,
	timeZone: TimeZoneId,
): string {
	if (!startTime && !endTime) {
		return "Last 12 hours"
	}

	if (!startTime || !endTime) {
		return "Custom range"
	}

	const start = new Date(normalizeTimestampInput(startTime))
	const end = new Date(normalizeTimestampInput(endTime))
	const diffMs = end.getTime() - start.getTime()

	const minutes = Math.round(diffMs / (60 * 1000))
	const hours = Math.round(diffMs / (60 * 60 * 1000))
	const days = Math.round(diffMs / (24 * 60 * 60 * 1000))
	const weeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000))

	// Check if end time is approximately now (within 1 minute)
	const isRelative = Math.abs(end.getTime() - Date.now()) < 60 * 1000

	if (isRelative) {
		if (minutes < 60) return `Last ${minutes} minute${minutes !== 1 ? "s" : ""}`
		if (hours < 24) return `Last ${hours} hour${hours !== 1 ? "s" : ""}`
		if (days < 7) return `Last ${days} day${days !== 1 ? "s" : ""}`
		if (weeks < 5) return `Last ${weeks} week${weeks !== 1 ? "s" : ""}`
		return `Last ${Math.round(days / 30)} month${Math.round(days / 30) !== 1 ? "s" : ""}`
	}

	return `${formatDateTime(start, { timeZone })} - ${formatDateTime(end, { timeZone })}`
}

export const PRESET_OPTIONS: TimePreset[] = [
	{
		label: "Last 5 minutes",
		value: "5m",
		getRange: () => relativeToAbsolute("5m")!,
	},
	{
		label: "Last 15 minutes",
		value: "15m",
		getRange: () => relativeToAbsolute("15m")!,
	},
	{
		label: "Last 30 minutes",
		value: "30m",
		getRange: () => relativeToAbsolute("30m")!,
	},
	{
		label: "Last 1 hour",
		value: "1h",
		getRange: () => relativeToAbsolute("1h")!,
	},
	{
		label: "Last 6 hours",
		value: "6h",
		getRange: () => relativeToAbsolute("6h")!,
	},
	{
		label: "Last 12 hours",
		value: "12h",
		getRange: () => relativeToAbsolute("12h")!,
	},
	{
		label: "Last 1 day",
		value: "1d",
		getRange: () => relativeToAbsolute("1d")!,
	},
	{
		label: "Last 3 days",
		value: "3d",
		getRange: () => relativeToAbsolute("3d")!,
	},
	{
		label: "Last 1 week",
		value: "1w",
		getRange: () => relativeToAbsolute("1w")!,
	},
	{
		label: "Last 2 weeks",
		value: "2w",
		getRange: () => relativeToAbsolute("2w")!,
	},
	{
		label: "Last 1 month",
		value: "1mo",
		getRange: () => relativeToAbsolute("1mo")!,
	},
]

export const QUICK_SELECT_OPTIONS: QuickSelectOption[] = [
	{ label: "3h", value: "3h" },
	{ label: "4d", value: "4d" },
	{ label: "6w", value: "6w" },
	{ label: "12h", value: "12h" },
	{ label: "10d", value: "10d" },
	{ label: "2w", value: "2w" },
	{ label: "2mo", value: "2mo" },
	{ label: "today", value: "today" },
]

const CACHE_SNAP_INTERVAL_S = 15

/**
 * Snap a Tinybird-format datetime string ("YYYY-MM-DD HH:mm:ss") to the
 * nearest floor of CACHE_SNAP_INTERVAL_S seconds for cache key deduplication.
 * Returns the original string unchanged if it doesn't match the format.
 */
export function snapTimestamp(value: string): string {
	if (value.length !== 19 || value[4] !== "-" || value[10] !== " ") return value
	const seconds = parseInt(value.slice(17, 19), 10)
	if (Number.isNaN(seconds)) return value
	const snapped = seconds - (seconds % CACHE_SNAP_INTERVAL_S)
	return value.slice(0, 17) + snapped.toString().padStart(2, "0")
}
