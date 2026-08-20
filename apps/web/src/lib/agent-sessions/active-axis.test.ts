import { describe, expect, it } from "vitest"

import { buildSessionAxis, formatAxisTick } from "./active-axis"
import type { IdleGap } from "./session-summary"

const SECOND = 1000
const MINUTE = 60 * SECOND
const START = 1_787_140_000_000

const gap = (startMs: number, endMs: number): IdleGap => ({
	id: `gap:${startMs}`,
	startMs: START + startMs,
	endMs: START + endMs,
	durationMs: endMs - startMs,
})

describe("buildSessionAxis", () => {
	it("is plain elapsed time when nothing is collapsed", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START + 2 * MINUTE, collapsedGaps: [] })

		expect(axis.totalMs).toBe(2 * MINUTE)
		expect(axis.toAxisMs(START + 30 * SECOND)).toBe(30 * SECOND)
		expect(axis.fraction(START + MINUTE)).toBe(0.5)
	})

	it("shortens the axis by every collapsed gap", () => {
		const axis = buildSessionAxis({
			startMs: START,
			endMs: START + 10 * MINUTE,
			collapsedGaps: [gap(MINUTE, 4 * MINUTE), gap(6 * MINUTE, 8 * MINUTE)],
		})

		expect(axis.totalMs).toBe(5 * MINUTE)
		expect(axis.removedMs).toBe(5 * MINUTE)
		expect(axis.removedGapCount).toBe(2)
	})

	it("maps instants around a collapsed gap onto the shortened axis", () => {
		const axis = buildSessionAxis({
			startMs: START,
			endMs: START + 10 * MINUTE,
			collapsedGaps: [gap(MINUTE, 4 * MINUTE)],
		})

		// Before the gap: untouched.
		expect(axis.toAxisMs(START + 30 * SECOND)).toBe(30 * SECOND)
		// After it: the whole gap is gone.
		expect(axis.toAxisMs(START + 5 * MINUTE)).toBe(2 * MINUTE)
		// Inside it: the seam the gap collapsed to.
		expect(axis.toAxisMs(START + 2 * MINUTE)).toBe(MINUTE)
		expect(axis.toAxisMs(START + 4 * MINUTE)).toBe(MINUTE)
	})

	it("clamps instants outside the session to the ends of the axis", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START + MINUTE, collapsedGaps: [] })

		expect(axis.fraction(START - MINUTE)).toBe(0)
		expect(axis.fraction(START + 10 * MINUTE)).toBe(1)
	})

	it("takes gaps in any order", () => {
		const axis = buildSessionAxis({
			startMs: START,
			endMs: START + 10 * MINUTE,
			collapsedGaps: [gap(6 * MINUTE, 8 * MINUTE), gap(MINUTE, 4 * MINUTE)],
		})

		expect(axis.toAxisMs(START + 9 * MINUTE)).toBe(4 * MINUTE)
	})

	it("labels a ruler that starts at zero and ends at the axis length", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START + 4 * MINUTE, collapsedGaps: [] })

		expect(axis.ticks).toHaveLength(6)
		expect(axis.ticks[0]).toEqual({ axisMs: 0, label: "0s" })
		expect(axis.ticks[5]!.axisMs).toBe(axis.totalMs)
	})

	it("survives a session with no measurable duration", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START, collapsedGaps: [] })

		expect(axis.fraction(START)).toBe(0)
		expect(Number.isFinite(axis.fraction(START + SECOND))).toBe(true)
	})
})

describe("formatAxisTick", () => {
	it("writes minutes out with their seconds, which the shared formatter drops", () => {
		expect(formatAxisTick(90 * SECOND, 45 * SECOND)).toBe("1m 30s")
		expect(formatAxisTick(3 * MINUTE, 45 * SECOND)).toBe("3m 00s")
	})

	it("defers to the shared duration formatter below a minute", () => {
		expect(formatAxisTick(0, 45 * SECOND)).toBe("0s")
		expect(formatAxisTick(45 * SECOND, 45 * SECOND)).toBe("45s")
	})
})
