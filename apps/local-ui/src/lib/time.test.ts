import { afterEach, describe, expect, it, vi } from "vitest"
import { boundsForRange } from "./time"

describe("boundsForRange", () => {
	afterEach(() => vi.useRealTimers())

	it("can advance every consumer from one explicit page anchor", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:00Z"))
		const initial = boundsForRange("1h", Date.now())

		vi.setSystemTime(new Date("2026-07-30T16:05:00Z"))
		const advanced = boundsForRange("1h", Date.now())

		expect(initial).toEqual({
			startTime: "2026-07-30 13:05:00",
			endTime: "2026-07-30 15:05:00",
		})
		expect(advanced).toEqual({
			startTime: "2026-07-30 15:05:00",
			endTime: "2026-07-30 17:05:00",
		})
	})
})
