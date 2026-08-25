import { describe, expect, it } from "vitest"
import { normalizeTime, rangeExceededResult, resolveTimeRange, timeRangeInvalidResult } from "./time"

describe("normalizeTime", () => {
	it("passes through already-correct format", () => {
		expect(normalizeTime("2026-03-30 14:30:00")).toBe("2026-03-30 14:30:00")
	})

	it("converts ISO 8601 with Z", () => {
		expect(normalizeTime("2026-03-30T14:30:00Z")).toBe("2026-03-30 14:30:00")
	})

	it("converts ISO 8601 with milliseconds", () => {
		expect(normalizeTime("2026-03-30T14:30:00.000Z")).toBe("2026-03-30 14:30:00")
	})

	it("converts ISO 8601 with positive timezone offset to UTC", () => {
		expect(normalizeTime("2026-03-30T14:30:00+09:00")).toBe("2026-03-30 05:30:00")
	})

	it("converts ISO 8601 with negative timezone offset to UTC", () => {
		expect(normalizeTime("2026-03-30T14:30:00-05:00")).toBe("2026-03-30 19:30:00")
	})

	it("handles date rollover on UTC conversion", () => {
		expect(normalizeTime("2026-03-30T00:00:00+09:00")).toBe("2026-03-29 15:00:00")
	})

	it("returns null for unparseable strings", () => {
		expect(normalizeTime("not-a-date")).toBeNull()
	})

	// The shape an agent actually produced: a real date sheared into nonsense.
	// Passing it through put `toDateTime('2026-08-47:53')` into live SQL.
	it("returns null for a malformed date that looks plausible", () => {
		expect(normalizeTime("2026-08-47:53")).toBeNull()
		expect(normalizeTime("2026-13-01 00:00:00")).toBeNull()
	})

	it("trims whitespace", () => {
		expect(normalizeTime("  2026-03-30 14:30:00  ")).toBe("2026-03-30 14:30:00")
	})
})

describe("resolveTimeRange", () => {
	it("normalizes both provided values", () => {
		const { st, et } = resolveTimeRange("2026-03-30T10:00:00Z", "2026-03-30T16:00:00Z")
		expect(st).toBe("2026-03-30 10:00:00")
		expect(et).toBe("2026-03-30 16:00:00")
	})

	it("returns default window when neither is provided", () => {
		const { st, et } = resolveTimeRange(undefined, undefined)
		// Both should match YYYY-MM-DD HH:mm:ss format
		expect(st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(et).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		// Default window is 6 hours
		const startMs = new Date(st.replace(" ", "T") + "Z").getTime()
		const endMs = new Date(et.replace(" ", "T") + "Z").getTime()
		const diffHours = (endMs - startMs) / (1000 * 60 * 60)
		expect(diffHours).toBeCloseTo(6, 0)
	})

	it("normalizes start and uses default end when only start provided", () => {
		const { st, et } = resolveTimeRange("2026-03-30T10:00:00+09:00", undefined)
		expect(st).toBe("2026-03-30 01:00:00")
		expect(et).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})

	it("uses default start and normalizes end when only end provided", () => {
		const { st, et } = resolveTimeRange(undefined, "2026-03-30T16:00:00Z")
		expect(st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(et).toBe("2026-03-30 16:00:00")
	})

	it("preserves numeric third-arg as defaultHours (back-compat)", () => {
		const { st, et } = resolveTimeRange(undefined, undefined, 1)
		const startMs = new Date(st.replace(" ", "T") + "Z").getTime()
		const endMs = new Date(et.replace(" ", "T") + "Z").getTime()
		expect((endMs - startMs) / 3600_000).toBeCloseTo(1, 0)
	})

	it("flags an over-wide range without truncating it", () => {
		const result = resolveTimeRange("2026-03-01T00:00:00Z", "2026-03-30T00:00:00Z", { maxHours: 24 * 7 })
		expect(result.exceeded).toBe(true)
		// The window is reported back verbatim — callers reject rather than clamp,
		// so the agent never receives a silently narrowed answer.
		expect(result.st).toBe("2026-03-01 00:00:00")
		expect(result.et).toBe("2026-03-30 00:00:00")
		expect(result.maxHours).toBe(24 * 7)
		expect(result.requestedHours).toBe(29 * 24)
	})

	it("accepts a range within maxHours", () => {
		const result = resolveTimeRange("2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z", { maxHours: 24 * 7 })
		expect(result.exceeded).toBe(false)
		expect(result.st).toBe("2026-03-29 00:00:00")
		expect(result.et).toBe("2026-03-30 00:00:00")
	})

	it("never flags exceeded when no cap is set", () => {
		const result = resolveTimeRange("2020-01-01T00:00:00Z", "2026-03-30T00:00:00Z")
		expect(result.exceeded).toBe(false)
	})

	it("reports an unparseable bound and falls back to the default for it", () => {
		const result = resolveTimeRange("2026-08-47:53", "2026-03-30T16:00:00Z")
		expect(result.invalid).toEqual([{ param: "start_time", value: "2026-08-47:53" }])
		// The bad bound never reaches SQL — it becomes a well-formed default.
		expect(result.st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(result.et).toBe("2026-03-30 16:00:00")
	})

	it("reports both bounds when both are unparseable", () => {
		const result = resolveTimeRange("nope", "also-nope")
		expect(result.invalid).toEqual([
			{ param: "start_time", value: "nope" },
			{ param: "end_time", value: "also-nope" },
		])
		expect(result.st).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(result.et).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})

	it("is empty-invalid for a sound range", () => {
		expect(resolveTimeRange("2026-03-30T10:00:00Z", "2026-03-30T16:00:00Z").invalid).toEqual([])
		expect(resolveTimeRange(undefined, undefined).invalid).toEqual([])
	})

	// A garbage bound collapses to the default window, whose width is under any
	// cap — reporting `exceeded` there would send the agent chasing the wrong fix.
	it("prefers the invalid signal over exceeded", () => {
		const result = resolveTimeRange("nope", "2026-03-30T16:00:00Z", { maxHours: 1 })
		expect(result.invalid).toHaveLength(1)
		expect(result.exceeded).toBe(false)
	})
})

describe("timeRangeInvalidResult", () => {
	it("names the bad value and the accepted formats", () => {
		const result = timeRangeInvalidResult(
			{ invalid: [{ param: "start_time", value: "2026-08-47:53" }] },
			"explore_attributes",
		)
		expect(result.isError).toBe(true)
		const text = result.content[0].text
		expect(text).toContain("explore_attributes")
		expect(text).toContain('start_time="2026-08-47:53"')
		expect(text).toContain("YYYY-MM-DD HH:mm:ss")
	})

	it("lists both bounds when both were bad", () => {
		const text = timeRangeInvalidResult(
			{
				invalid: [
					{ param: "start_time", value: "a" },
					{ param: "end_time", value: "b" },
				],
			},
			"search_traces",
		).content[0].text
		expect(text).toContain('start_time="a" and end_time="b"')
	})
})

describe("rangeExceededResult", () => {
	it("reports what was asked for, the cap, and the way forward", () => {
		const range = { maxHours: 24 * 7, requestedHours: 24 * 30 }
		const result = rangeExceededResult(range, "search_traces")

		expect(result.isError).toBe(true)
		const text = result.content[0].text
		expect(text).toContain("search_traces")
		expect(text).toContain("Requested 30 days")
		expect(text).toContain("maximum supported range is 7 days")
		expect(text).toContain("query_data")
	})

	it("formats sub-day caps as hours", () => {
		const text = rangeExceededResult({ maxHours: 6, requestedHours: 48 }, "mine_log_patterns").content[0]
			.text
		expect(text).toContain("Requested 2 days")
		expect(text).toContain("maximum supported range is 6 hours")
	})

	it("omits the requested width when the bounds were unparseable", () => {
		const text = rangeExceededResult({ maxHours: 24, requestedHours: undefined }, "search_logs")
			.content[0].text
		expect(text).toContain("Maximum supported range is 1 day")
		expect(text).not.toContain("Requested")
	})
})
