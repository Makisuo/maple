// The waterfall's time axis, with the idle removed.
//
// A session that a human replied to twice is mostly nothing happening: without
// collapsing the gaps, ~70% of the waterfall is empty and every bar is a
// hairline. Collapsing maps absolute time onto a shorter axis by subtracting the
// gaps the user chose to hide, which keeps the bars proportional to each other
// while the axis reads in cumulative active time.

import { formatDurationAtStep } from "@maple/ui/lib/format"

import type { IdleGap } from "./session-summary"

export interface AxisTick {
	/** Offset along the axis, in axis milliseconds. */
	readonly axisMs: number
	readonly label: string
}

export interface SessionAxis {
	readonly startMs: number
	/** Axis length: wall clock minus every collapsed gap. */
	readonly totalMs: number
	readonly removedMs: number
	readonly removedGapCount: number
	readonly ticks: readonly AxisTick[]
	/** Absolute instant → offset along the axis. */
	readonly toAxisMs: (ms: number) => number
	/** Absolute instant → 0…1 position along the axis. */
	readonly fraction: (ms: number) => number
}

/**
 * Ruler steps a reader can hold: the 1/2/5 × 10ⁿ ladder plus the clock values a
 * duration axis wants. Splitting the total into equal fifths instead prints
 * ticks like "1m 07s", which nothing in the rows below lines up with.
 */
const AXIS_STEPS_MS = [
	1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
	600_000, 900_000, 1_800_000, 3_600_000,
]
const AXIS_TICK_TARGET = 6
const HOUR_MS = 3_600_000

export function buildSessionAxis(options: {
	readonly startMs: number
	readonly endMs: number
	/** The gaps to remove. The caller decides which — an expanded gap is simply absent. */
	readonly collapsedGaps: readonly IdleGap[]
}): SessionAxis {
	const { startMs, endMs } = options
	const collapsedGaps = [...options.collapsedGaps].sort((a, b) => a.startMs - b.startMs)
	const removedMs = collapsedGaps.reduce((total, gap) => total + gap.durationMs, 0)
	// A one-millisecond floor rather than a guard at every call site: the axis is
	// only ever used as a denominator.
	const totalMs = Math.max(1, endMs - startMs - removedMs)

	const toAxisMs = (ms: number): number => {
		let axisMs = ms - startMs
		for (const gap of collapsedGaps) {
			if (ms <= gap.startMs) break
			// An instant inside a collapsed gap lands on the seam where the gap was.
			axisMs -= Math.min(ms, gap.endMs) - gap.startMs
		}
		return Math.min(Math.max(axisMs, 0), totalMs)
	}

	return {
		startMs,
		totalMs,
		removedMs,
		removedGapCount: collapsedGaps.length,
		ticks: axisTicks(totalMs),
		toAxisMs,
		fraction: (ms) => toAxisMs(ms) / totalMs,
	}
}

function axisTicks(totalMs: number): readonly AxisTick[] {
	const rough = totalMs / (AXIS_TICK_TARGET - 1)
	const step = AXIS_STEPS_MS.find((candidate) => candidate >= rough) ?? Math.ceil(rough / HOUR_MS) * HOUR_MS
	const ticks: AxisTick[] = []
	// The closing tick is the axis length itself, drawn right-aligned against the
	// edge — a stepped tick landing next to it would overprint the label.
	for (let axisMs = 0; axisMs < totalMs * 0.94; axisMs += step) {
		ticks.push({ axisMs, label: formatAxisTick(axisMs, step) })
	}
	ticks.push({ axisMs: totalMs, label: formatAxisTick(totalMs, step) })
	return ticks
}

/**
 * Ruler label for an offset into the session.
 *
 * `formatDurationAtStep` is the app's axis formatter and handles everything
 * under a minute, but its minute rendering ("1.5min") drops the seconds a
 * session ruler needs to line up with the durations in the rows beside it — so
 * minutes are written out as `m` + `s` here.
 */
export function formatAxisTick(ms: number, stepMs: number): string {
	if (ms <= 0) return "0s"
	if (ms < 60_000) return formatDurationAtStep(ms, stepMs)
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}
