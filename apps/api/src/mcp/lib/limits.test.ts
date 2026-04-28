import { describe, expect, it } from "vitest"
import { clampLimit, clampOffset } from "./limits"

describe("clampLimit", () => {
	it("returns the default when undefined", () => {
		expect(clampLimit(undefined, { defaultValue: 20, max: 200 })).toBe(20)
	})

	it("returns the user value when within bounds", () => {
		expect(clampLimit(50, { defaultValue: 20, max: 200 })).toBe(50)
	})

	it("caps at max when user value exceeds", () => {
		expect(clampLimit(99999, { defaultValue: 20, max: 200 })).toBe(200)
	})

	it("floors fractional values", () => {
		expect(clampLimit(17.9, { defaultValue: 20, max: 200 })).toBe(17)
	})

	it("falls back to default for non-finite or <= 0", () => {
		expect(clampLimit(NaN, { defaultValue: 20, max: 200 })).toBe(20)
		expect(clampLimit(Number.POSITIVE_INFINITY, { defaultValue: 20, max: 200 })).toBe(20)
		expect(clampLimit(0, { defaultValue: 20, max: 200 })).toBe(20)
		expect(clampLimit(-5, { defaultValue: 20, max: 200 })).toBe(20)
	})
})

describe("clampOffset", () => {
	it("returns 0 when undefined", () => {
		expect(clampOffset(undefined, { max: 10_000 })).toBe(0)
	})

	it("returns the user value when within bounds", () => {
		expect(clampOffset(100, { max: 10_000 })).toBe(100)
	})

	it("caps at max", () => {
		expect(clampOffset(999_999, { max: 10_000 })).toBe(10_000)
	})

	it("floors fractional values", () => {
		expect(clampOffset(42.7, { max: 10_000 })).toBe(42)
	})

	it("returns 0 for negative or non-finite values", () => {
		expect(clampOffset(-1, { max: 10_000 })).toBe(0)
		expect(clampOffset(NaN, { max: 10_000 })).toBe(0)
	})
})
