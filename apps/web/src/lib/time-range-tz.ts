import { TZDate } from "@date-fns/tz"
import type { TimeZoneId } from "@maple/ui/lib/time-format"
import { formatForTinybird } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

// ---------------------------------------------------------------------------
// Wall-clock ⇄ UTC conversion in a selected timezone.
//
// The custom range picker lets the user pick a calendar day + "HH:mm" that they
// mean *in the selected display timezone*. Warehouse strings, however, are
// tz-less UTC ("YYYY-MM-DD HH:mm:ss"). These helpers translate between the two
// using `@date-fns/tz`'s `TZDate`, which interprets its Y/M/D/h/m fields in the
// given zone (`.getTime()` then yields the correct UTC instant) and, when
// constructed from an epoch, reports Y/M/D/h/m as seen in that zone.
// ---------------------------------------------------------------------------

/** A calendar wall-clock reading (month is 0-based, matching `Date`/`TZDate`). */
export interface WallClock {
	year: number
	/** 0-11 */
	month: number
	day: number
	hours: number
	minutes: number
}

/**
 * Interpret a wall-clock reading as local time in `timeZone` and return the
 * corresponding UTC warehouse string ("YYYY-MM-DD HH:mm:ss").
 *
 * DST note: a nonexistent local time (spring-forward gap) is normalized by
 * `TZDate` to the adjacent valid instant, so no exception is thrown.
 */
export function wallClockToWarehouse(wall: WallClock, timeZone: TimeZoneId): string {
	const zoned = new TZDate(wall.year, wall.month, wall.day, wall.hours, wall.minutes, 0, timeZone)
	return formatForTinybird(new Date(zoned.getTime()))
}

/**
 * Inverse of {@link wallClockToWarehouse}: read a UTC warehouse string as
 * wall-clock fields in `timeZone` (for re-opening the picker on a stored range).
 */
export function warehouseToWallClock(warehouse: string, timeZone: TimeZoneId): WallClock {
	const instant = new Date(normalizeTimestampInput(warehouse))
	const zoned = new TZDate(instant.getTime(), timeZone)
	return {
		year: zoned.getFullYear(),
		month: zoned.getMonth(),
		day: zoned.getDate(),
		hours: zoned.getHours(),
		minutes: zoned.getMinutes(),
	}
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0")
}

/** "HH:mm" for a wall-clock reading (date-fns `format` is timezone-unsafe/banned). */
export function wallClockTimeInput(wall: Pick<WallClock, "hours" | "minutes">): string {
	return `${pad2(wall.hours)}:${pad2(wall.minutes)}`
}

/** A calendar-day `Date` (local midnight) for a wall-clock reading — feeds react-day-picker. */
export function wallClockCalendarDay(wall: Pick<WallClock, "year" | "month" | "day">): Date {
	return new Date(wall.year, wall.month, wall.day)
}
