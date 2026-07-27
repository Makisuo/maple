import { describe, expect, it } from "vitest"

import {
	formatRelativeFrom,
	formatRelativeShort,
	formatRelativeShortFrom,
	formatRelativeTime,
	formatRelativeTimeOrDate,
	relativeParts,
	toEpochMs,
} from "../time-format"

// A fixed "now" everywhere: these formatters take `nowMs` precisely so the suite
// never needs fake timers and never goes flaky at a boundary.
const NOW = Date.parse("2026-05-24T14:30:00Z")
const ago = (ms: number) => NOW - ms

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("toEpochMs", () => {
	it("reads a tz-less warehouse DateTime as UTC, not local", () => {
		// The bug this whole module exists to prevent: `new Date("2026-05-24 14:30:00")`
		// is local time in V8, so it skews by the runtime's offset. Under a non-UTC
		// TZ this assertion fails for any implementation that forgets to normalize.
		expect(toEpochMs("2026-05-24 14:30:00")).toBe(Date.parse("2026-05-24T14:30:00Z"))
	})

	it("passes through strings that already carry a zone", () => {
		expect(toEpochMs("2026-05-24T14:30:00Z")).toBe(NOW)
		expect(toEpochMs("2026-05-24T16:30:00+02:00")).toBe(NOW)
	})

	it("accepts Date and epoch-ms unchanged", () => {
		expect(toEpochMs(new Date(NOW))).toBe(NOW)
		expect(toEpochMs(NOW)).toBe(NOW)
	})

	it("returns NaN for unparseable input", () => {
		expect(Number.isNaN(toEpochMs("not a timestamp"))).toBe(true)
	})

	it("agrees across every input shape for the same instant", () => {
		const shapes = ["2026-05-24 14:30:00", "2026-05-24T14:30:00Z", new Date(NOW), NOW] as const
		const rendered = shapes.map((shape) => formatRelativeTime(shape, NOW + HOUR))
		expect(new Set(rendered).size).toBe(1)
		expect(rendered[0]).toBe("1h ago")
	})
})

describe("relativeParts", () => {
	it("floors at every ladder boundary rather than rounding up", () => {
		// 59m must not read as "1h" — the rounding disagreement between the old
		// copies was visible as timestamps jumping a unit early.
		expect(relativeParts(ago(59 * MINUTE), NOW)).toMatchObject({ value: 59, unit: "m" })
		expect(relativeParts(ago(60 * MINUTE), NOW)).toMatchObject({ value: 1, unit: "h" })
		expect(relativeParts(ago(59 * SECOND), NOW)).toMatchObject({ value: 59, unit: "s" })
		expect(relativeParts(ago(23 * HOUR), NOW)).toMatchObject({ value: 23, unit: "h" })
		expect(relativeParts(ago(24 * HOUR), NOW)).toMatchObject({ value: 1, unit: "d" })
		expect(relativeParts(ago(29 * DAY), NOW)).toMatchObject({ value: 29, unit: "d" })
		expect(relativeParts(ago(30 * DAY), NOW)).toMatchObject({ value: 1, unit: "mo" })
		expect(relativeParts(ago(364 * DAY), NOW)).toMatchObject({ value: 12, unit: "mo" })
		expect(relativeParts(ago(365 * DAY), NOW)).toMatchObject({ value: 1, unit: "y" })
	})

	it("flags future instants instead of rendering a negative", () => {
		expect(relativeParts(NOW + 2 * HOUR, NOW)).toMatchObject({ value: 2, unit: "h", future: true })
	})
})

describe("formatRelativeFrom", () => {
	it("renders the ladder", () => {
		expect(formatRelativeFrom(ago(30 * SECOND), NOW)).toBe("30s ago")
		expect(formatRelativeFrom(ago(5 * MINUTE), NOW)).toBe("5m ago")
		expect(formatRelativeFrom(ago(3 * HOUR), NOW)).toBe("3h ago")
		expect(formatRelativeFrom(ago(2 * DAY), NOW)).toBe("2d ago")
		expect(formatRelativeFrom(ago(400 * DAY), NOW)).toBe("1y ago")
	})

	it("collapses the last few seconds to 'just now'", () => {
		expect(formatRelativeFrom(NOW, NOW)).toBe("just now")
		expect(formatRelativeFrom(ago(4 * SECOND), NOW)).toBe("just now")
		expect(formatRelativeFrom(ago(5 * SECOND), NOW)).toBe("5s ago")
	})

	it("renders clock skew forwards, not as a negative age", () => {
		expect(formatRelativeFrom(NOW + 2 * HOUR, NOW)).toBe("in 2h")
	})

	it("renders an em dash for unparseable input", () => {
		expect(formatRelativeTime("nonsense", NOW)).toBe("—")
	})
})

describe("formatRelativeShortFrom", () => {
	it("drops the 'ago' suffix", () => {
		expect(formatRelativeShortFrom(ago(3 * HOUR), NOW)).toBe("3h")
		expect(formatRelativeShortFrom(NOW, NOW)).toBe("now")
		expect(formatRelativeShort("2026-05-24 12:30:00", NOW)).toBe("2h")
	})
})

describe("formatRelativeTimeOrDate", () => {
	it("stays relative inside the 7-day window", () => {
		expect(formatRelativeTimeOrDate(ago(6 * DAY), NOW)).toBe("6d ago")
	})

	it("switches to an absolute date at 7 days", () => {
		const rendered = formatRelativeTimeOrDate(ago(7 * DAY), NOW)
		expect(rendered).not.toContain("ago")
		expect(rendered).toContain("2026")
	})
})
