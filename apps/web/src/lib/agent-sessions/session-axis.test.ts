import { describe, expect, it } from "vitest"

import { buildSessionAxis } from "./session-axis"
import type { IdleGap } from "./session-summary"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
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
		expect(axis.fraction(START + MINUTE)).toBe(0.5)
	})

	it("shortens the axis by every collapsed gap, in any order", () => {
		const axis = buildSessionAxis({
			startMs: START,
			endMs: START + 10 * MINUTE,
			collapsedGaps: [gap(6 * MINUTE, 8 * MINUTE), gap(MINUTE, 4 * MINUTE)],
		})

		expect(axis.totalMs).toBe(5 * MINUTE)
		expect(axis.removedMs).toBe(5 * MINUTE)
		expect(axis.removedGapCount).toBe(2)
		// 9m wall clock is 4m of active time once both gaps are gone.
		expect(axis.fraction(START + 9 * MINUTE)).toBe(0.8)
	})

	it("collapses a gap to a seam: every instant inside it maps to one point", () => {
		const axis = buildSessionAxis({
			startMs: START,
			endMs: START + 10 * MINUTE,
			collapsedGaps: [gap(MINUTE, 4 * MINUTE)],
		})

		const seam = axis.fraction(START + MINUTE)
		expect(axis.fraction(START + 2 * MINUTE)).toBe(seam)
		expect(axis.fraction(START + 4 * MINUTE)).toBe(seam)
		// And time outside the gap is untouched: 5m wall clock is 2m of axis.
		expect(axis.fraction(START + 5 * MINUTE)).toBe((2 * MINUTE) / axis.totalMs)
	})

	it("clamps instants outside the session to the ends of the axis", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START + MINUTE, collapsedGaps: [] })

		expect(axis.fraction(START - MINUTE)).toBe(0)
		expect(axis.fraction(START + 10 * MINUTE)).toBe(1)
	})

	// The ruler's invariants, rather than its exact strings: labels have to stay
	// distinct and ordered at every session length the page actually sees, from a
	// couple of seconds to an agent that waited on a human overnight.
	const DURATIONS: readonly [string, number][] = [
		["2s", 2 * SECOND],
		["52s", 52 * SECOND],
		["4m", 4 * MINUTE],
		["16m", 16 * MINUTE],
		["70m", 70 * MINUTE],
		["6h", 6 * HOUR],
		["20h", 20 * HOUR],
	]

	it.each(DURATIONS)("rules a %s session with ordered, distinct labels", (_name, durationMs) => {
		const { ticks } = buildSessionAxis({ startMs: START, endMs: START + durationMs, collapsedGaps: [] })

		expect(ticks.length).toBeGreaterThan(1)
		expect(ticks[0]!.label).toBe("0s")
		expect(ticks[0]!.fraction).toBe(0)
		for (const [index, tick] of ticks.entries()) {
			expect(tick.fraction).toBeGreaterThanOrEqual(0)
			expect(tick.fraction).toBeLessThanOrEqual(1)
			if (index > 0) expect(tick.fraction).toBeGreaterThan(ticks[index - 1]!.fraction)
		}
		expect(new Set(ticks.map((tick) => tick.label)).size).toBe(ticks.length)
	})

	it("steps the ruler in clock values rather than fifths of the total", () => {
		// 52s: 15s steps, not the 13s an even division would give.
		const short = buildSessionAxis({ startMs: START, endMs: START + 52 * SECOND, collapsedGaps: [] })
		expect(short.ticks.map((tick) => tick.label)).toEqual(["0s", "15s", "30s", "45s"])

		// Hours, not the "360m" an unrolled minute count would print.
		const long = buildSessionAxis({ startMs: START, endMs: START + 6 * HOUR, collapsedGaps: [] })
		expect(long.ticks.map((tick) => tick.label)).toEqual(["0s", "2h 0m", "4h 0m", "6h 0m"])
	})

	it("survives a session with no measurable duration", () => {
		const axis = buildSessionAxis({ startMs: START, endMs: START, collapsedGaps: [] })

		expect(axis.fraction(START)).toBe(0)
		expect(Number.isFinite(axis.fraction(START + SECOND))).toBe(true)
	})
})
