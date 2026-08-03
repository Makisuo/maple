import { describe, it, expect } from "vitest"
import { formatWarehouseDateTimeMs } from "@maple/query-engine"
import {
	buildTimeline,
	COLLAPSED_GAP_MS,
	parseChTimestampMs,
	spanDisplayRange,
	type InactiveInterval,
} from "./replay-timeline"

describe("buildTimeline", () => {
	it("is an identity mapping with no idle gaps", () => {
		const t = buildTimeline([], 60_000)
		expect(t.activeTotalMs).toBe(60_000)
		expect(t.toDisplay(0)).toBe(0)
		expect(t.toDisplay(30_000)).toBe(30_000)
		expect(t.toDisplay(60_000)).toBe(60_000)
		expect(t.toReal(30_000)).toBe(30_000)
	})

	it("is an identity mapping when intervals are empty (skip-idle off)", () => {
		const intervals: InactiveInterval[] = []
		const t = buildTimeline(intervals, 120_000)
		expect(t.activeTotalMs).toBe(120_000)
		for (const x of [0, 1_000, 75_000, 120_000]) {
			expect(t.toReal(t.toDisplay(x))).toBeCloseTo(x, 5)
		}
	})

	it("collapses a single large idle gap to COLLAPSED_GAP_MS", () => {
		// 5s active, 45min idle, 5s active. Real total = 2_710_000ms.
		const gap = 2_700_000
		const realTotal = 5_000 + gap + 5_000
		const t = buildTimeline([{ start: 5_000, end: 5_000 + gap }], realTotal)

		// Active total = realTotal − (gap − COLLAPSED_GAP_MS).
		expect(t.activeTotalMs).toBe(realTotal - (gap - COLLAPSED_GAP_MS))
		expect(t.activeTotalMs).toBe(5_000 + COLLAPSED_GAP_MS + 5_000)
	})

	it("maps points before, inside, and after a gap", () => {
		const gap = 2_700_000
		const realTotal = 5_000 + gap + 5_000
		const start = 5_000
		const end = start + gap
		const t = buildTimeline([{ start, end }], realTotal)

		// Before the gap → unchanged.
		expect(t.toDisplay(4_000)).toBe(4_000)
		// Inside the gap → clamped to start + at most COLLAPSED_GAP_MS.
		expect(t.toDisplay(start + 500)).toBe(start + 500)
		expect(t.toDisplay(start + 10_000)).toBe(start + COLLAPSED_GAP_MS)
		// After the gap → shifted left by the collapsed amount.
		expect(t.toDisplay(end + 2_000)).toBe(start + COLLAPSED_GAP_MS + 2_000)
		expect(t.toDisplay(realTotal)).toBe(t.activeTotalMs)
	})

	it("round-trips toReal(toDisplay(x)) for active points; gap points resume at the gap end", () => {
		const gap = 600_000
		const realTotal = 10_000 + gap + 10_000
		const start = 10_000
		const end = start + gap
		const t = buildTimeline([{ start, end }], realTotal)

		// Active-region points round-trip exactly.
		for (const x of [0, 5_000, 10_000, end + 5_000, realTotal]) {
			expect(t.toReal(t.toDisplay(x))).toBeCloseTo(x, 5)
		}

		// A display position landing within the collapsed gap resumes at the gap's
		// content edge (matches skip-idle playback jumping to gap.end).
		const insideCollapsed = start + COLLAPSED_GAP_MS / 2
		expect(t.toReal(insideCollapsed)).toBe(end)
	})

	it("clamps out-of-range inputs", () => {
		const t = buildTimeline([{ start: 1_000, end: 5_000 }], 10_000)
		expect(t.toDisplay(-100)).toBe(0)
		expect(t.toDisplay(999_999)).toBe(t.activeTotalMs)
		expect(t.toReal(-100)).toBe(0)
		expect(t.toReal(999_999)).toBeCloseTo(10_000, 5)
	})

	it("ignores an interval entirely out of range", () => {
		// A gap past realTotalMs clamps to a zero-width span and is dropped, so the
		// mapping stays identity (no spurious collapse).
		const t = buildTimeline([{ start: 50_000, end: 60_000 }], 40_000)
		expect(t.activeTotalMs).toBe(40_000)
		expect(t.toDisplay(20_000)).toBe(20_000)
		expect(t.toReal(t.toDisplay(20_000))).toBeCloseTo(20_000, 5)
	})

	it("ignores a zero-width interval", () => {
		// start === end carries no idle time; it must not collapse anything.
		const t = buildTimeline([{ start: 10_000, end: 10_000 }], 40_000)
		expect(t.activeTotalMs).toBe(40_000)
		expect(t.toDisplay(10_000)).toBe(10_000)
		expect(t.toDisplay(25_000)).toBe(25_000)
	})

	it("merges overlapping intervals", () => {
		// Two overlapping gaps should collapse as one combined gap.
		const t = buildTimeline(
			[
				{ start: 5_000, end: 20_000 },
				{ start: 15_000, end: 30_000 },
			],
			40_000,
		)
		// Combined gap = 5_000..30_000 (25_000ms) → collapsed to COLLAPSED_GAP_MS.
		expect(t.activeTotalMs).toBe(40_000 - (25_000 - COLLAPSED_GAP_MS))
	})
})

describe("parseChTimestampMs", () => {
	const expected = Date.UTC(2026, 4, 22, 10, 30, 45, 123)

	it("parses a space-separated ClickHouse DateTime64 as UTC", () => {
		expect(parseChTimestampMs("2026-05-22 10:30:45.123")).toBe(expected)
	})

	it("parses without fractional seconds", () => {
		expect(parseChTimestampMs("2026-05-22 10:30:45")).toBe(Date.UTC(2026, 4, 22, 10, 30, 45))
	})

	it("accepts an explicit zone or T separator without double-appending Z", () => {
		expect(parseChTimestampMs("2026-05-22T10:30:45.123Z")).toBe(expected)
		expect(parseChTimestampMs("2026-05-22 10:30:45.123Z")).toBe(expected)
	})

	it("returns NaN for empty/garbage input", () => {
		expect(Number.isNaN(parseChTimestampMs(""))).toBe(true)
		expect(Number.isNaN(parseChTimestampMs("not-a-date"))).toBe(true)
	})
})

describe("spanDisplayRange", () => {
	// Recording starts at this epoch ms; the playhead's time-zero.
	const recordingStartEpochMs = Date.UTC(2026, 4, 22, 10, 30, 45, 0)
	const isoAt = (offsetMs: number) => formatWarehouseDateTimeMs(recordingStartEpochMs + offsetMs)

	it("maps a span's absolute start to a rrweb-relative offset (identity timeline)", () => {
		const timeline = buildTimeline([], 60_000)
		const r = spanDisplayRange({
			spanStartIso: isoAt(10_000),
			durationMs: 2_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
			timeline,
		})
		expect(r.realOffsetMs).toBe(10_000)
		expect(r.displayStartMs).toBe(10_000)
		expect(r.displayEndMs).toBe(12_000)
		expect(r.outOfRange).toBe(false)
	})

	it("flags and pins a span starting before the recording", () => {
		const timeline = buildTimeline([], 60_000)
		const r = spanDisplayRange({
			spanStartIso: isoAt(-5_000),
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
			timeline,
		})
		expect(r.realOffsetMs).toBe(-5_000)
		expect(r.outOfRange).toBe(true)
		// toDisplay clamps to 0 — pinned to the left edge.
		expect(r.displayStartMs).toBe(0)
	})

	it("flags a span starting after the recording ends", () => {
		const timeline = buildTimeline([], 60_000)
		const r = spanDisplayRange({
			spanStartIso: isoAt(75_000),
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
			timeline,
		})
		expect(r.outOfRange).toBe(true)
		expect(r.displayStartMs).toBe(timeline.activeTotalMs)
	})

	it("maps a span through a collapsed idle gap", () => {
		// 5s active, 600s idle, 5s active.
		const gap = 600_000
		const realTotal = 5_000 + gap + 5_000
		const timeline = buildTimeline([{ start: 5_000, end: 5_000 + gap }], realTotal)
		// A span firing just after the gap should land just past the collapsed gap.
		const r = spanDisplayRange({
			spanStartIso: isoAt(5_000 + gap + 2_000),
			durationMs: 500,
			recordingStartEpochMs,
			realTotalMs: realTotal,
			timeline,
		})
		expect(r.displayStartMs).toBe(5_000 + COLLAPSED_GAP_MS + 2_000)
		expect(r.outOfRange).toBe(false)
	})

	it("treats an unparseable timestamp as out of range", () => {
		const timeline = buildTimeline([], 60_000)
		const r = spanDisplayRange({
			spanStartIso: "garbage",
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
			timeline,
		})
		expect(r.outOfRange).toBe(true)
		expect(r.displayStartMs).toBe(0)
	})
})
