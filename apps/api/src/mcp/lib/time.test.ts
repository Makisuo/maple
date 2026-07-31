import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { formatClampNote, normalizeTime, resolveTimeRange } from "./time"

// 2026-03-30 12:00:00 UTC — every default-window assertion derives from this.
const NOW = Date.UTC(2026, 2, 30, 12, 0, 0)

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

	it("returns unparseable strings as-is", () => {
		expect(normalizeTime("not-a-date")).toBe("not-a-date")
	})

	it("trims whitespace", () => {
		expect(normalizeTime("  2026-03-30 14:30:00  ")).toBe("2026-03-30 14:30:00")
	})
})

describe("resolveTimeRange", () => {
	it.effect("normalizes both provided values", () =>
		Effect.gen(function* () {
			const { st, et } = yield* resolveTimeRange("2026-03-30T10:00:00Z", "2026-03-30T16:00:00Z")
			assert.strictEqual(st, "2026-03-30 10:00:00")
			assert.strictEqual(et, "2026-03-30 16:00:00")
		}),
	)

	it.effect("returns default 6h window when neither is provided", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const { st, et } = yield* resolveTimeRange(undefined, undefined)
			assert.strictEqual(st, "2026-03-30 06:00:00")
			assert.strictEqual(et, "2026-03-30 12:00:00")
		}),
	)

	it.effect("normalizes start and uses the clock for end when only start provided", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const { st, et } = yield* resolveTimeRange("2026-03-30T10:00:00+09:00", undefined)
			assert.strictEqual(st, "2026-03-30 01:00:00")
			assert.strictEqual(et, "2026-03-30 12:00:00")
		}),
	)

	it.effect("uses default start and normalizes end when only end provided", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const { st, et } = yield* resolveTimeRange(undefined, "2026-03-30T16:00:00Z")
			assert.strictEqual(st, "2026-03-30 06:00:00")
			assert.strictEqual(et, "2026-03-30 16:00:00")
		}),
	)

	it.effect("preserves numeric third-arg as defaultHours (back-compat)", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const { st, et } = yield* resolveTimeRange(undefined, undefined, 1)
			assert.strictEqual(st, "2026-03-30 11:00:00")
			assert.strictEqual(et, "2026-03-30 12:00:00")
		}),
	)

	it.effect("clamps start when range exceeds maxHours", () =>
		Effect.gen(function* () {
			const result = yield* resolveTimeRange("2026-03-01T00:00:00Z", "2026-03-30T00:00:00Z", {
				maxHours: 24 * 7,
			})
			assert.isTrue(result.clamped)
			assert.strictEqual(result.et, "2026-03-30 00:00:00")
			assert.strictEqual(result.st, "2026-03-23 00:00:00")
			assert.strictEqual(result.maxHours, 24 * 7)
		}),
	)

	it.effect("does not clamp when range is within maxHours", () =>
		Effect.gen(function* () {
			const result = yield* resolveTimeRange("2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z", {
				maxHours: 24 * 7,
			})
			assert.isFalse(result.clamped)
			assert.strictEqual(result.st, "2026-03-29 00:00:00")
			assert.strictEqual(result.et, "2026-03-30 00:00:00")
		}),
	)
})

describe("formatClampNote", () => {
	it("returns empty string when not clamped", () => {
		expect(formatClampNote({ clamped: false, maxHours: 24 })).toBe("")
	})

	it("formats whole-day windows as days", () => {
		expect(formatClampNote({ clamped: true, maxHours: 24 })).toBe(" (range clamped to 1 day)")
		expect(formatClampNote({ clamped: true, maxHours: 24 * 7 })).toBe(" (range clamped to 7 days)")
	})

	it("formats sub-day windows as hours", () => {
		expect(formatClampNote({ clamped: true, maxHours: 6 })).toBe(" (range clamped to 6 hours)")
		expect(formatClampNote({ clamped: true, maxHours: 1 })).toBe(" (range clamped to 1 hour)")
	})
})
