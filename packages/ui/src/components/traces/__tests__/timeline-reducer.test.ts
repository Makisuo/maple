import { describe, expect, it } from "vitest"
import { clampViewport, timelineReducer } from "../use-trace-timeline"
import type { TimelineState } from "../trace-timeline-types"
import { MIN_VISIBLE_ABS_MS } from "../trace-timeline-types"

const TRACE_START = 0
const TRACE_END = 10_000 // 10s trace

function baseState(viewport = { startMs: 0, endMs: 10_000 }): TimelineState {
	return {
		viewport,
		focusedIndex: 3,
		searchQuery: "db",
		expandedSpanIds: new Set(["a", "b"]),
	}
}

describe("clampViewport min-visible floor", () => {
	it("floors a zero-width window to the absolute minimum", () => {
		const vp = clampViewport({ startMs: 5_000, endMs: 5_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
		expect(vp.startMs).toBeCloseTo(5_000, 6)
	})

	it("never collapses below the absolute floor on a tiny trace", () => {
		const vp = clampViewport({ startMs: 50, endMs: 50 }, 0, 100)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
	})

	it("caps an over-wide window at traceDuration * 1.1", () => {
		const vp = clampViewport({ startMs: -50_000, endMs: 50_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(11_000, 6)
	})

	it("keeps a normal window untouched", () => {
		const vp = clampViewport({ startMs: 2_000, endMs: 4_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeCloseTo(2_000, 6)
		expect(vp.endMs).toBeCloseTo(4_000, 6)
	})
})

describe("clampViewport boundaries", () => {
	const LO = TRACE_START - 10_000 * 0.05 // -500 (5% padding)
	const HI = TRACE_END + 10_000 * 0.05 // 10_500

	it("clamps a window fully left of the trace back inside", () => {
		const vp = clampViewport({ startMs: -30_000, endMs: -28_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeGreaterThanOrEqual(LO)
		expect(vp.endMs).toBeLessThanOrEqual(HI)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})

	it("clamps a window fully right of the trace back inside", () => {
		const vp = clampViewport({ startMs: 40_000, endMs: 42_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeGreaterThanOrEqual(LO)
		expect(vp.endMs).toBeLessThanOrEqual(HI)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})

	it("centers a window capped to the max width (no left-edge re-violation)", () => {
		const vp = clampViewport({ startMs: -1_000, endMs: 11_500 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(11_000, 6)
		expect(vp.startMs).toBeCloseTo(LO, 6)
		expect(vp.endMs).toBeCloseTo(HI, 6)
	})

	it("stays finite and floored on a zero-duration trace", () => {
		const vp = clampViewport({ startMs: 5_000, endMs: 5_000 }, 5_000, 5_000)
		expect(Number.isFinite(vp.startMs)).toBe(true)
		expect(Number.isFinite(vp.endMs)).toBe(true)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
		// Centered on the instant
		expect((vp.startMs + vp.endMs) / 2).toBeCloseTo(5_000, 6)
	})

	it("recovers from NaN/Infinity inputs", () => {
		for (const bad of [
			{ startMs: Number.NaN, endMs: Number.NaN },
			{ startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY },
			{ startMs: 0, endMs: Number.POSITIVE_INFINITY },
		]) {
			const vp = clampViewport(bad, TRACE_START, TRACE_END)
			expect(Number.isFinite(vp.startMs)).toBe(true)
			expect(Number.isFinite(vp.endMs)).toBe(true)
			expect(vp.endMs).toBeGreaterThan(vp.startMs)
		}
	})
})

describe("SET_VIEWPORT", () => {
	it("clamps a minimap drag that leaves the trace entirely", () => {
		const next = timelineReducer(baseState({ startMs: 8_000, endMs: 10_000 }), {
			type: "SET_VIEWPORT",
			viewport: { startMs: 38_000, endMs: 40_000 },
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.startMs).toBeGreaterThanOrEqual(TRACE_START - 500)
		expect(next.viewport.endMs).toBeLessThanOrEqual(TRACE_END + 500)
		expect(next.viewport.endMs - next.viewport.startMs).toBeCloseTo(2_000, 6)
	})

	it("clamps a resize wider than the trace", () => {
		const next = timelineReducer(baseState(), {
			type: "SET_VIEWPORT",
			viewport: { startMs: -100_000, endMs: 100_000 },
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.endMs - next.viewport.startMs).toBeCloseTo(11_000, 6)
	})
})

describe("ZOOM_TO_RANGE", () => {
	it("zooms to the dragged window without extra padding", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 2_000,
			endMs: 3_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.startMs).toBeCloseTo(2_000, 6)
		expect(next.viewport.endMs).toBeCloseTo(3_000, 6)
	})

	it("normalizes a reversed (right-to-left) drag", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 3_000,
			endMs: 2_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.startMs).toBeCloseTo(2_000, 6)
		expect(next.viewport.endMs).toBeCloseTo(3_000, 6)
	})

	it("applies the min-visible floor to a too-small drag", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 5_000,
			endMs: 5_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.endMs - next.viewport.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
	})

	it("leaves unrelated state fields intact", () => {
		const prev = baseState()
		const next = timelineReducer(prev, {
			type: "ZOOM_TO_RANGE",
			startMs: 1_000,
			endMs: 8_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.focusedIndex).toBe(prev.focusedIndex)
		expect(next.searchQuery).toBe(prev.searchQuery)
		expect(next.expandedSpanIds).toBe(prev.expandedSpanIds)
	})
})
