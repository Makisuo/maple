import { describe, expect, it } from "vitest"
import { normalizeTimestampInput } from "./timezone-format"

describe("normalizeTimestampInput", () => {
	it("marks tz-less Tinybird datetime strings as explicit UTC", () => {
		expect(normalizeTimestampInput("2026-02-27 12:54:36")).toBe("2026-02-27T12:54:36Z")
	})

	it("normalizes Tinybird fractional seconds to milliseconds", () => {
		expect(normalizeTimestampInput("2026-02-27 12:54:36.123456")).toBe("2026-02-27T12:54:36.123Z")
	})

	it("handles the T separator without a timezone", () => {
		expect(normalizeTimestampInput("2026-02-27T12:54:36")).toBe("2026-02-27T12:54:36Z")
	})

	it("passes through already-zoned ISO strings unchanged (trimmed)", () => {
		expect(normalizeTimestampInput("2024-01-01T12:00:00.000Z")).toBe("2024-01-01T12:00:00.000Z")
		expect(normalizeTimestampInput("  2024-01-01T12:00:00Z  ")).toBe("2024-01-01T12:00:00Z")
	})

	it("passes through non-matching values (trimmed)", () => {
		expect(normalizeTimestampInput("not-a-date")).toBe("not-a-date")
	})
})
