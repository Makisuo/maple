// ---------------------------------------------------------------------------
// Canonical, timezone-aware absolute-time formatting.
//
// Pure module — no React, no date-fns, no query-engine import. Lives in
// packages/ui so charts here can format without depending on apps/web. Every
// formatter REQUIRES a branded `TimeZoneId`, which is only obtainable through
// the preference system (`makeTimeZoneId` / `browserTimeZoneId`), so a
// formatter can never be called with an ad-hoc hardcoded zone.
// ---------------------------------------------------------------------------

/**
 * A validated IANA timezone identifier. The brand is freely exported, but the
 * only constructors are `makeTimeZoneId` / `browserTimeZoneId` (and, downstream,
 * the preference system) — formatters are therefore uncallable with a raw
 * string.
 */
export type TimeZoneId = string & { readonly __TimeZoneId: unique symbol }

/**
 * Validate an IANA zone via `Intl` and brand it; falls back to `"UTC"` when the
 * zone is unknown/unsupported. IMPORT-RESTRICTED (oxlint) to the preference
 * system + this module.
 */
export function makeTimeZoneId(iana: string): TimeZoneId {
	try {
		// Constructing a formatter throws (RangeError) on an invalid zone.
		new Intl.DateTimeFormat("en-US", { timeZone: iana })
		return iana as TimeZoneId
	} catch {
		return "UTC" as TimeZoneId
	}
}

/** The provider default: the browser's resolved zone, or `"UTC"` if unavailable. */
export function browserTimeZoneId(): TimeZoneId {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (zone) return makeTimeZoneId(zone)
	} catch {
		// fall through to UTC
	}
	return "UTC" as TimeZoneId
}

// ---------------------------------------------------------------------------
// Warehouse DateTime normalization
//
// Self-contained copy of query-engine's `warehouseDateTimeToIso`
// (packages/query-engine/src/datetime.ts) so this module stays dependency-free.
// ClickHouse/Tinybird return tz-less `YYYY-MM-DD HH:MM:SS[.fff]` strings that
// `new Date()` would misparse as local time; this marks them explicit-UTC.
// Already-zoned / non-matching shapes pass through trimmed.
// ---------------------------------------------------------------------------

const WAREHOUSE_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

function warehouseDateTimeToIso(value: string): string {
	const trimmed = value.trim()
	const match = WAREHOUSE_DATETIME_PATTERN.exec(trimmed)
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

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

type TimeFormatInput = string | number | Date

function resolveInput(input: TimeFormatInput): Date | null {
	const normalized = typeof input === "string" ? warehouseDateTimeToIso(input) : input
	const date = normalized instanceof Date ? normalized : new Date(normalized)
	return Number.isNaN(date.getTime()) ? null : date
}

/**
 * One cache keyed by `locale + serialized options` (options include `timeZone`),
 * so every formatter variant is constructed once. `JSON.stringify` drops
 * `undefined`-valued keys, keeping keys stable across the option-toggling below.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale ?? ""}|${JSON.stringify(options)}`
	let formatter = formatterCache.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, options)
		formatterCache.set(key, formatter)
	}
	return formatter
}

interface ZonedParts {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
}

/** Calendar-field breakdown of `date` as seen in `timeZone` (via `formatToParts`). */
function zonedParts(date: Date, timeZone: TimeZoneId): ZonedParts {
	const parts = getFormatter("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date)

	const read = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((part) => part.type === type)?.value
		return value ? Number(value) : 0
	}

	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour"),
		minute: read("minute"),
		second: read("second"),
	}
}

/** Whole-day number (days since epoch) of `date`'s calendar day in `timeZone`. */
function zonedDayNumber(date: Date, timeZone: TimeZoneId): number {
	const { year, month, day } = zonedParts(date, timeZone)
	return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** The `longOffset` timeZoneName string for `timeZone` at `at` — e.g. "GMT+05:30", "GMT". */
function longOffset(timeZone: TimeZoneId, at: Date): string {
	const parts = getFormatter("en-US", {
		timeZone,
		timeZoneName: "longOffset",
		year: "numeric",
	}).formatToParts(at)
	return parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT"
}

// ---------------------------------------------------------------------------
// Public formatters
// ---------------------------------------------------------------------------

/**
 * Absolute timestamp: "MMM d, hh:mm:ss AM/PM" in `timeZone`. Matches the legacy
 * `formatTimestampInTimezone` output exactly (its consumers migrate 1:1).
 */
export function formatTimestamp(
	input: TimeFormatInput,
	options: { timeZone: TimeZoneId; withMilliseconds?: boolean },
): string {
	const date = resolveInput(input)
	if (!date) return "-"

	return getFormatter("en-US", {
		timeZone: options.timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: options.withMilliseconds ? 3 : undefined,
	}).format(date)
}

/** Time of day: "hh:mm AM/PM" (optionally with seconds) in `timeZone`. */
export function formatTimeOfDay(
	input: TimeFormatInput,
	options: { timeZone: TimeZoneId; withSeconds?: boolean },
): string {
	const date = resolveInput(input)
	if (!date) return "-"

	return getFormatter("en-US", {
		timeZone: options.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		second: options.withSeconds ? "2-digit" : undefined,
	}).format(date)
}

/** Millisecond-precision wall-clock time "HH:mm:ss.SSS" (24h) in `timeZone`. */
export function formatCompactTime(input: TimeFormatInput, options: { timeZone: TimeZoneId }): string {
	const date = resolveInput(input)
	if (!date) return "-"

	return getFormatter("en-GB", {
		timeZone: options.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
		hour12: false,
	}).format(date)
}

/**
 * General date+time "MMM d[, yyyy] HH:mm[:ss]" (24h) in `timeZone`. Pass
 * `dateOnly` for a bare calendar date "MMM d[, yyyy]" (no time component).
 */
export function formatDateTime(
	input: TimeFormatInput,
	options: { timeZone: TimeZoneId; year?: boolean; seconds?: boolean; dateOnly?: boolean },
): string {
	const date = resolveInput(input)
	if (!date) return "-"

	return getFormatter("en-US", {
		timeZone: options.timeZone,
		year: options.year ? "numeric" : undefined,
		month: "short",
		day: "numeric",
		hour: options.dateOnly ? undefined : "2-digit",
		minute: options.dateOnly ? undefined : "2-digit",
		second: options.dateOnly || !options.seconds ? undefined : "2-digit",
		hourCycle: "h23",
	}).format(date)
}

/**
 * Stable calendar-day key ("2026-6-4") for `input` as seen in `timeZone`, for
 * bucketing events into per-day groups. Not for display — pair it with
 * `formatDayHeading` for the visible label.
 */
export function zonedDayKey(input: TimeFormatInput, timeZone: TimeZoneId): string {
	const date = resolveInput(input)
	if (!date) return "invalid"

	const { year, month, day } = zonedParts(date, timeZone)
	return `${year}-${month}-${day}`
}

/** Day heading: "Today"/"Yesterday"/"MMM d, yyyy", with the day computed in `timeZone`. */
export function formatDayHeading(input: TimeFormatInput, options: { timeZone: TimeZoneId }): string {
	const date = resolveInput(input)
	if (!date) return "-"

	const diff = zonedDayNumber(new Date(), options.timeZone) - zonedDayNumber(date, options.timeZone)
	if (diff === 0) return "Today"
	if (diff === 1) return "Yesterday"

	return getFormatter("en-US", {
		timeZone: options.timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(date)
}

/**
 * Adaptive chart bucket label, timezone-aware. Identical visual output to the
 * legacy local-time copies when `timeZone` is the browser zone:
 * - >= 24h with daily buckets: "Feb 14"
 * - >= 24h with sub-day buckets: "Feb 14, 02:00 PM"
 * - 30min - 24h: "02:00 PM"
 * - <= 30min: "02:00:30 PM"
 *
 * Uses the runtime default locale (`undefined`) to mirror the previous
 * `toLocaleString(undefined, …)` calls; `timeZone` is threaded through every
 * branch so labels render in the selected zone.
 */
export function formatBucketLabel(
	value: unknown,
	context: { rangeMs: number; bucketSeconds: number | undefined },
	mode: "tick" | "tooltip",
	timeZone: TimeZoneId,
): string {
	if (typeof value !== "string") return ""

	const date = new Date(warehouseDateTimeToIso(value))
	if (Number.isNaN(date.getTime())) return value

	const includeDate = context.rangeMs >= 24 * 60 * 60 * 1000 || (context.bucketSeconds ?? 0) >= 24 * 60 * 60
	const includeSeconds = context.rangeMs <= 30 * 60 * 1000 && !includeDate

	if (mode === "tooltip") {
		return getFormatter(undefined, {
			timeZone,
			year: includeDate ? "numeric" : undefined,
			month: includeDate ? "short" : undefined,
			day: includeDate ? "numeric" : undefined,
			hour: "2-digit",
			minute: "2-digit",
			second: includeSeconds ? "2-digit" : undefined,
		}).format(date)
	}

	if (includeDate) {
		if ((context.bucketSeconds ?? 0) >= 24 * 60 * 60) {
			return getFormatter(undefined, { timeZone, month: "short", day: "numeric" }).format(date)
		}
		return getFormatter(undefined, {
			timeZone,
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date)
	}

	return getFormatter(undefined, {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		second: includeSeconds ? "2-digit" : undefined,
	})
		.format(date)
		.replace(/^24:/, "00:")
}

/** Offset label for pickers: "(UTC+02:00)" / "(UTC+00:00)", DST-aware at `at`. */
export function formatOffsetLabel(timeZone: TimeZoneId, at: Date = new Date()): string {
	const raw = longOffset(timeZone, at)
	const body = raw.replace("GMT", "") || "+00:00"
	return `(UTC${body})`
}

/** Signed offset from UTC in minutes for `timeZone` at `at` (DST-aware, handles :30/:45 zones). */
export function getOffsetMinutes(timeZone: TimeZoneId, at: Date = new Date()): number {
	const raw = longOffset(timeZone, at)
	const match = /GMT([+-])(\d{2}):(\d{2})/.exec(raw)
	if (!match) return 0
	const sign = match[1] === "-" ? -1 : 1
	return sign * (Number(match[2]) * 60 + Number(match[3]))
}
