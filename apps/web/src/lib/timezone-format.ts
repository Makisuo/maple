import { getBrowserTimeZone, isValidIanaTimeZone } from "@/atoms/timezone-preference-atoms"

type TimezoneFormatInput = string | number | Date

const TINYBIRD_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

export function normalizeTimestampInput(value: string): string {
	const trimmed = value.trim()
	const match = TINYBIRD_UTC_PATTERN.exec(trimmed)
	if (!match) {
		return trimmed
	}

	const [, date, time, fractional] = match
	if (!fractional) {
		return `${date}T${time}Z`
	}

	const milliseconds = `${fractional}000`.slice(0, 3)
	return `${date}T${time}.${milliseconds}Z`
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
