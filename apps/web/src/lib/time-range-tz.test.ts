import { afterEach, describe, expect, it, vi } from "vitest"
import type { TimeZoneId } from "@maple/ui/lib/time-format"
import { formatTimeRangeDisplay, relativeToAbsolute } from "@/lib/time-utils"
import {
	warehouseToWallClock,
	wallClockToWarehouse,
	type WallClock,
} from "@/lib/time-range-tz"

// `supportedTimezones` are validated IANA ids at runtime; tests construct the
// branded id directly rather than routing through the preference atom.
const tz = (zone: string): TimeZoneId => zone as TimeZoneId

const BERLIN = tz("Europe/Berlin") // +02:00 in summer
const NEW_YORK = tz("America/New_York") // -04:00 in summer (EDT)
const KOLKATA = tz("Asia/Kolkata") // +05:30 (no DST)
const UTC = tz("UTC")

afterEach(() => {
	vi.useRealTimers()
})

describe("wallClockToWarehouse", () => {
	it("converts east-of-UTC wall clock to UTC (Berlin +02:00)", () => {
		const wall: WallClock = { year: 2024, month: 5, day: 15, hours: 12, minutes: 0 }
		expect(wallClockToWarehouse(wall, BERLIN)).toBe("2024-06-15 10:00:00")
	})

	it("converts half-hour east zone (Kolkata +05:30)", () => {
		const wall: WallClock = { year: 2024, month: 5, day: 15, hours: 12, minutes: 0 }
		expect(wallClockToWarehouse(wall, KOLKATA)).toBe("2024-06-15 06:30:00")
	})

	it("converts west-of-UTC wall clock to UTC (New York EDT -04:00)", () => {
		const wall: WallClock = { year: 2024, month: 5, day: 15, hours: 12, minutes: 0 }
		expect(wallClockToWarehouse(wall, NEW_YORK)).toBe("2024-06-15 16:00:00")
	})

	it("is identity for UTC", () => {
		const wall: WallClock = { year: 2024, month: 0, day: 2, hours: 3, minutes: 45 }
		expect(wallClockToWarehouse(wall, UTC)).toBe("2024-01-02 03:45:00")
	})

	it("normalizes a nonexistent spring-forward local time (New York 02:30)", () => {
		// 2024-03-10 02:00 → 03:00 EDT: 02:30 does not exist. TZDate maps it to the
		// adjacent valid instant (03:30 EDT = 07:30 UTC) instead of throwing.
		const wall: WallClock = { year: 2024, month: 2, day: 10, hours: 2, minutes: 30 }
		const warehouse = wallClockToWarehouse(wall, NEW_YORK)
		expect(warehouse).toBe("2024-03-10 07:30:00")
		// Reading the resulting instant back yields the shifted-forward wall time.
		expect(warehouseToWallClock(warehouse, NEW_YORK)).toMatchObject({ hours: 3, minutes: 30 })
	})
})

describe("wall-clock ⇄ warehouse round-trip", () => {
	const cases: Array<[string, TimeZoneId, WallClock]> = [
		["Berlin", BERLIN, { year: 2024, month: 5, day: 15, hours: 9, minutes: 15 }],
		["New York", NEW_YORK, { year: 2024, month: 10, day: 3, hours: 23, minutes: 5 }],
		["Kolkata", KOLKATA, { year: 2024, month: 5, day: 15, hours: 12, minutes: 30 }],
		["UTC", UTC, { year: 2023, month: 11, day: 31, hours: 18, minutes: 0 }],
	]

	it.each(cases)("round-trips a valid wall clock (%s)", (_name, zone, wall) => {
		const warehouse = wallClockToWarehouse(wall, zone)
		expect(warehouseToWallClock(warehouse, zone)).toEqual(wall)
	})
})

describe("relativeToAbsolute today, timezone-aware", () => {
	it("returns midnight in a west zone (New York)", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2024-07-01T15:00:00Z")) // 11:00 EDT

		const range = relativeToAbsolute("today", NEW_YORK)
		expect(range).not.toBeNull()
		expect(range?.startTime).toBe("2024-07-01 04:00:00") // midnight EDT
		expect(range?.endTime).toBe("2024-07-01 15:00:00")
		expect(warehouseToWallClock(range!.startTime, NEW_YORK)).toMatchObject({
			day: 1,
			hours: 0,
			minutes: 0,
		})
	})

	it("returns midnight in a half-hour east zone (Kolkata) — previous UTC day", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2024-07-01T15:00:00Z")) // 20:30 IST

		const range = relativeToAbsolute("today", KOLKATA)
		expect(range?.startTime).toBe("2024-06-30 18:30:00") // IST midnight = prev UTC day
		expect(warehouseToWallClock(range!.startTime, KOLKATA)).toMatchObject({
			day: 1,
			hours: 0,
			minutes: 0,
		})
	})

	it("returns EST midnight on a spring-forward day (New York)", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2024-03-10T18:00:00Z")) // 14:00 EDT, after the 02:00 jump

		const range = relativeToAbsolute("today", NEW_YORK)
		// Midnight was still EST (-05:00) — the clocks jumped at 02:00, not 00:00.
		expect(range?.startTime).toBe("2024-03-10 05:00:00")
	})

	it("falls back to browser-local midnight when no timezone is given", () => {
		const range = relativeToAbsolute("today")
		expect(range).not.toBeNull()
		// The endTime is always "now"; the startTime is a valid warehouse string.
		expect(range?.startTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})
})

describe("formatTimeRangeDisplay in a non-browser timezone", () => {
	it("formats an absolute range's bounds in the given zone (Kolkata)", () => {
		// 06:30 UTC → 12:00 IST; 08:30 UTC → 14:00 IST.
		const label = formatTimeRangeDisplay("2024-06-15 06:30:00", "2024-06-15 08:30:00", KOLKATA)
		expect(label).toBe("Jun 15, 12:00 - Jun 15, 14:00")
	})

	it("formats the same instants differently in a west zone (New York)", () => {
		// 06:30 UTC → 02:30 EDT; 08:30 UTC → 04:30 EDT.
		const label = formatTimeRangeDisplay("2024-06-15 06:30:00", "2024-06-15 08:30:00", NEW_YORK)
		expect(label).toBe("Jun 15, 02:30 - Jun 15, 04:30")
	})

	it("labels relative-to-now windows without a date", () => {
		const now = new Date()
		const end = now.toISOString().replace("T", " ").slice(0, 19)
		const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19)
		expect(formatTimeRangeDisplay(start, end, UTC)).toBe("Last 1 hour")
	})
})
