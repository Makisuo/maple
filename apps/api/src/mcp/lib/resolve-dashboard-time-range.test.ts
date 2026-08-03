import { describe, expect, it } from "vitest"
import { resolveDashboardTimeRange, validateDashboardTimeRange } from "./resolve-dashboard-time-range"

describe("validateDashboardTimeRange", () => {
	it("accepts ranges the old {1h, 6h, 24h, 7d} whitelist rejected", () => {
		// The regression this whole change exists for: `create_dashboard` used to
		// map anything outside the whitelist to "1h" without saying so, which is
		// why agent-created dashboards appeared to cap out at a week.
		for (const value of ["30d", "14d", "2w", "4w", "15m", "today"]) {
			expect(validateDashboardTimeRange(value)).toBeNull()
		}
	})

	it("rejects month-scale ranges, which exceed the engine's real ceiling", () => {
		// Dashboard widgets top out at 31 days — wider than the old 7-day
		// whitelist suggested, but genuinely bounded. Long-range routes that read
		// the 365-day rollups (service pages, the service map) are separate.
		expect(validateDashboardTimeRange("3mo")).toContain("31 days")
	})

	it("still accepts the four values the whitelist allowed", () => {
		for (const value of ["1h", "6h", "24h", "7d"]) {
			expect(validateDashboardTimeRange(value)).toBeNull()
		}
	})

	it("rejects a range past the engine ceiling instead of downgrading it", () => {
		const error = validateDashboardTimeRange("999d")
		expect(error).not.toBeNull()
		expect(error).toContain("999d")
		expect(error).toContain("31 days")
	})

	it("rejects malformed shorthand with usable guidance", () => {
		const error = validateDashboardTimeRange("last month")
		expect(error).not.toBeNull()
		expect(error).toContain("Invalid time range")
	})
})

describe("resolveDashboardTimeRange", () => {
	const spanSeconds = (range: { startTime: string; endTime: string }) =>
		(Date.parse(`${range.endTime}Z`.replace(" ", "T")) -
			Date.parse(`${range.startTime}Z`.replace(" ", "T"))) /
		1000

	it("resolves a 30-day relative range to a 30-day window", () => {
		const resolved = resolveDashboardTimeRange({ type: "relative", value: "30d" })
		expect(resolved).not.toBeNull()
		expect(spanSeconds(resolved!)).toBeCloseTo(30 * 86_400, -1)
	})

	it('resolves "today", which the picker can persist but this used to reject', () => {
		const resolved = resolveDashboardTimeRange({ type: "relative", value: "today" })
		expect(resolved).not.toBeNull()

		// Start-of-day is the *local* calendar day, matching the web picker. On a
		// Worker local is UTC so this renders as 00:00:00, but the assertion is
		// written against the runtime's zone so it holds on a developer machine
		// with a UTC offset too.
		const localMidnight = new Date()
		localMidnight.setHours(0, 0, 0, 0)
		expect(resolved!.startTime).toBe(
			new Date(localMidnight.getTime()).toISOString().replace("T", " ").slice(0, 19),
		)
	})

	it("returns null for shorthand it cannot parse", () => {
		expect(resolveDashboardTimeRange({ type: "relative", value: "last month" })).toBeNull()
		expect(resolveDashboardTimeRange({ type: "relative", value: "" })).toBeNull()
	})

	it("passes absolute ranges through in warehouse format", () => {
		const resolved = resolveDashboardTimeRange({
			type: "absolute",
			startTime: "2026-03-01T00:00:00Z",
			endTime: "2026-03-08T00:00:00Z",
		})
		expect(resolved).toEqual({
			startTime: "2026-03-01 00:00:00",
			endTime: "2026-03-08 00:00:00",
		})
	})
})
