import { setSystemTime } from "bun:test"
import { afterEach, describe, expect, it } from "vitest"
import {
	browserTimeZoneId,
	formatBucketLabel,
	formatDateTime,
	formatDayHeading,
	formatOffsetLabel,
	formatTimestamp,
	getOffsetMinutes,
	makeTimeZoneId,
	zonedDayKey,
	type TimeZoneId,
} from "../time-format"

// Branded zones under test. `makeTimeZoneId` is the only public constructor.
const UTC = makeTimeZoneId("UTC")
const NEW_YORK = makeTimeZoneId("America/New_York")
const KOLKATA = makeTimeZoneId("Asia/Kolkata")
const EUCLA = makeTimeZoneId("Australia/Eucla")
const HONOLULU = makeTimeZoneId("Pacific/Honolulu")

describe("makeTimeZoneId", () => {
	it("brands valid IANA zones and falls back to UTC otherwise", () => {
		expect(makeTimeZoneId("America/New_York")).toBe("America/New_York")
		expect(makeTimeZoneId("Not/AZone")).toBe("UTC")
		expect(makeTimeZoneId("")).toBe("UTC")
	})
})

describe("browserTimeZoneId", () => {
	it("returns a usable branded zone", () => {
		const zone = browserTimeZoneId()
		expect(typeof zone).toBe("string")
		expect(zone.length).toBeGreaterThan(0)
	})
})

describe("formatTimestamp", () => {
	const instant = "2024-01-01T12:00:00.000Z"

	it("renders the same instant per timezone (incl. half-hour / 45-min zones)", () => {
		expect(formatTimestamp(instant, { timeZone: UTC })).toBe("Jan 1 at 12:00:00 PM")
		expect(formatTimestamp(instant, { timeZone: NEW_YORK })).toBe("Jan 1 at 07:00:00 AM")
		expect(formatTimestamp(instant, { timeZone: KOLKATA })).toBe("Jan 1 at 05:30:00 PM")
		expect(formatTimestamp(instant, { timeZone: EUCLA })).toBe("Jan 1 at 08:45:00 PM")
	})

	it("tracks New York DST spring-forward and fall-back", () => {
		// 07:00Z on 2024-03-10 is 03:00 EDT (the 2am→3am gap already jumped).
		expect(formatTimestamp("2024-03-10T07:00:00Z", { timeZone: NEW_YORK })).toBe("Mar 10 at 03:00:00 AM")
		// 06:00Z on 2024-11-03 is 01:00 EST (clocks already fell back).
		expect(formatTimestamp("2024-11-03T06:00:00Z", { timeZone: NEW_YORK })).toBe("Nov 3 at 01:00:00 AM")
	})

	it("supports milliseconds", () => {
		expect(formatTimestamp("2024-01-01T12:00:00.123Z", { timeZone: UTC, withMilliseconds: true })).toBe(
			"Jan 1 at 12:00:00.123 PM",
		)
	})

	it("returns '-' for invalid input", () => {
		expect(formatTimestamp("not-a-date", { timeZone: UTC })).toBe("-")
	})

	// Parity with query-engine's warehouseDateTimeToIso: tz-less warehouse
	// strings are treated as UTC (matched here against hardcoded expectations).
	it("normalizes tz-less warehouse datetime strings as UTC", () => {
		expect(formatTimestamp("2026-02-27 12:54:36", { timeZone: UTC })).toBe("Feb 27 at 12:54:36 PM")
		expect(formatTimestamp("2024-01-01T12:00:00", { timeZone: UTC })).toBe("Jan 1 at 12:00:00 PM")
		expect(
			formatTimestamp("2026-02-27 12:54:36.123456", { timeZone: UTC, withMilliseconds: true }),
		).toBe("Feb 27 at 12:54:36.123 PM")
	})
})

describe("formatDateTime", () => {
	const instant = "2024-01-01T23:30:00.000Z"

	it("renders date+time (24h), optionally with year/seconds, per timezone", () => {
		expect(formatDateTime(instant, { timeZone: UTC })).toBe("Jan 1 at 23:30")
		expect(formatDateTime(instant, { timeZone: UTC, year: true })).toBe("Jan 1, 2024 at 23:30")
		expect(formatDateTime(instant, { timeZone: UTC, year: true, seconds: true })).toBe(
			"Jan 1, 2024 at 23:30:00",
		)
		// 23:30Z on the 1st is 05:00 on the 2nd in Kolkata (+05:30).
		expect(formatDateTime(instant, { timeZone: KOLKATA })).toBe("Jan 2 at 05:00")
	})

	it("dateOnly drops the time component (calendar day computed in timezone)", () => {
		expect(formatDateTime(instant, { timeZone: UTC, dateOnly: true })).toBe("Jan 1")
		expect(formatDateTime(instant, { timeZone: UTC, dateOnly: true, year: true })).toBe("Jan 1, 2024")
		// Same instant is already the 2nd in Kolkata.
		expect(formatDateTime(instant, { timeZone: KOLKATA, dateOnly: true, year: true })).toBe("Jan 2, 2024")
	})

	it("returns '-' for invalid input", () => {
		expect(formatDateTime("not-a-date", { timeZone: UTC })).toBe("-")
	})
})

describe("formatOffsetLabel / getOffsetMinutes", () => {
	const jan = new Date("2024-01-15T00:00:00Z")
	const jul = new Date("2024-07-15T00:00:00Z")

	it("formats DST-aware offset labels", () => {
		expect(formatOffsetLabel(UTC, jan)).toBe("(UTC+00:00)")
		expect(formatOffsetLabel(KOLKATA, jan)).toBe("(UTC+05:30)")
		expect(formatOffsetLabel(EUCLA, jan)).toBe("(UTC+08:45)")
		expect(formatOffsetLabel(NEW_YORK, jan)).toBe("(UTC-05:00)")
		expect(formatOffsetLabel(NEW_YORK, jul)).toBe("(UTC-04:00)")
	})

	it("derives signed offset minutes (DST + :30/:45 zones)", () => {
		expect(getOffsetMinutes(UTC, jan)).toBe(0)
		expect(getOffsetMinutes(KOLKATA, jan)).toBe(330)
		expect(getOffsetMinutes(EUCLA, jan)).toBe(525)
		expect(getOffsetMinutes(NEW_YORK, jan)).toBe(-300)
		expect(getOffsetMinutes(NEW_YORK, jul)).toBe(-240)
	})
})

describe("formatDayHeading", () => {
	afterEach(() => {
		setSystemTime() // restore the real clock
	})

	it("uses Today/Yesterday relative to the target timezone's calendar day", () => {
		// Fix now at 2024-06-15 15:00Z (the 15th in UTC; 05:00 the 15th in Honolulu).
		setSystemTime(new Date("2024-06-15T15:00:00Z"))

		// An instant at 05:00Z on the 15th: "Today" in UTC, but 19:00 on the
		// 14th in Honolulu → "Yesterday" there.
		const instant = "2024-06-15T05:00:00Z"
		expect(formatDayHeading(instant, { timeZone: UTC })).toBe("Today")
		expect(formatDayHeading(instant, { timeZone: HONOLULU })).toBe("Yesterday")
	})

	it("falls back to a localized date for older instants", () => {
		setSystemTime(new Date("2024-06-15T15:00:00Z"))
		expect(formatDayHeading("2024-01-01T12:00:00Z", { timeZone: UTC })).toBe("Jan 1, 2024")
	})
})

describe("zonedDayKey", () => {
	it("buckets an instant into the target timezone's calendar day", () => {
		// 05:00Z on the 15th is still the 14th (19:00) in Honolulu.
		const instant = "2024-06-15T05:00:00Z"
		expect(zonedDayKey(instant, UTC)).toBe("2024-6-15")
		expect(zonedDayKey(instant, HONOLULU)).toBe("2024-6-14")
	})

	it("groups two instants on the same tz-local day under one key", () => {
		const morning = zonedDayKey("2024-06-15T06:00:00Z", KOLKATA)
		const evening = zonedDayKey("2024-06-15T16:00:00Z", KOLKATA)
		expect(morning).toBe(evening)
	})

	it("returns a stable sentinel for invalid input", () => {
		expect(zonedDayKey("not-a-date", UTC)).toBe("invalid")
	})
})

describe("formatBucketLabel", () => {
	const midDay = "2024-06-15T14:30:00Z"
	const nearBoundary = "2024-06-15T20:00:00Z"

	it("tick, sub-day range → time only, per timezone", () => {
		const ctx = { rangeMs: 6 * 60 * 60 * 1000, bucketSeconds: 300 }
		expect(formatBucketLabel(midDay, ctx, "tick", UTC)).toBe("02:30 PM")
		expect(formatBucketLabel(midDay, ctx, "tick", KOLKATA)).toBe("08:00 PM")
	})

	it("tick, daily buckets → date only, day computed in timezone", () => {
		const ctx = { rangeMs: 7 * 24 * 60 * 60 * 1000, bucketSeconds: 86400 }
		expect(formatBucketLabel(nearBoundary, ctx, "tick", UTC)).toBe("Jun 15")
		// 20:00Z is 01:30 on the 16th in Kolkata.
		expect(formatBucketLabel(nearBoundary, ctx, "tick", KOLKATA)).toBe("Jun 16")
	})

	it("tooltip with date+time crosses the day boundary in timezone", () => {
		const ctx = { rangeMs: 48 * 60 * 60 * 1000, bucketSeconds: 3600 }
		expect(formatBucketLabel(nearBoundary, ctx, "tooltip", UTC)).toBe("Jun 15, 2024 at 08:00 PM")
		expect(formatBucketLabel(nearBoundary, ctx, "tooltip", KOLKATA)).toBe("Jun 16, 2024 at 01:30 AM")
	})

	it("<= 30min range includes seconds", () => {
		const ctx = { rangeMs: 15 * 60 * 1000, bucketSeconds: 60 }
		expect(formatBucketLabel("2024-06-15T14:30:45Z", ctx, "tick", UTC)).toBe("02:30:45 PM")
		expect(formatBucketLabel("2024-06-15T14:30:45Z", ctx, "tick", KOLKATA)).toBe("08:00:45 PM")
	})

	it("returns '' for non-strings and echoes unparseable values", () => {
		const ctx = { rangeMs: 1000, bucketSeconds: 60 }
		expect(formatBucketLabel(42 as unknown, ctx, "tick", UTC)).toBe("")
		expect(formatBucketLabel("nope", ctx, "tick", UTC)).toBe("nope")
	})

	// keep the type checker honest about the branded 4th arg
	const _tz: TimeZoneId = UTC
	void _tz
})
