import { warehouseDateTimeToIso } from "@maple/query-engine"
import { getBrowserTimeZone, isValidIanaTimeZone } from "@/atoms/timezone-preference-atoms"

type TimezoneFormatInput = string | number | Date

/**
 * Normalize a tz-less warehouse (Tinybird/ClickHouse) DateTime string to an
 * explicit-UTC ISO string. Delegates to the canonical shared helper so web,
 * mobile, and the API all agree on one normalization.
 */
export function normalizeTimestampInput(value: string): string {
	return warehouseDateTimeToIso(value)
}

function toValidDate(input: TimezoneFormatInput): Date | null {
	const normalized = typeof input === "string" ? normalizeTimestampInput(input) : input

	const date = normalized instanceof Date ? normalized : new Date(normalized)
	return Number.isNaN(date.getTime()) ? null : date
}

function resolveTimeZone(timeZone: string): string {
	return isValidIanaTimeZone(timeZone) ? timeZone : getBrowserTimeZone()
}

const timestampFormatters = new Map<string, Intl.DateTimeFormat>()
const timeFormatters = new Map<string, Intl.DateTimeFormat>()
const compactTimeFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatTimestampInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string; withMilliseconds?: boolean },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	const key = `${tz}|${options.withMilliseconds ? "ms" : ""}`
	let formatter = timestampFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			fractionalSecondDigits: options.withMilliseconds ? 3 : undefined,
		})
		timestampFormatters.set(key, formatter)
	}

	return formatter.format(date)
}

export function formatTimeInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string; withSeconds?: boolean },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	const key = `${tz}|${options.withSeconds ? "s" : ""}`
	let formatter = timeFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: options.withSeconds ? "2-digit" : undefined,
		})
		timeFormatters.set(key, formatter)
	}

	return formatter.format(date)
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>()

/** `14:21:58` — the transcript's clock gutter, where the millisecond
 *  `formatCompactTimeInTimezone` adds is noise down a thousand rows. */
export function formatClockInTimezone(input: TimezoneFormatInput, options: { timeZone: string }): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	let formatter = clockFormatters.get(tz)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
		clockFormatters.set(tz, formatter)
	}

	return formatter.format(date)
}

export function formatCompactTimeInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	let formatter = compactTimeFormatters.get(tz)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			fractionalSecondDigits: 3,
			hour12: false,
		})
		compactTimeFormatters.set(tz, formatter)
	}

	return formatter.format(date)
}
