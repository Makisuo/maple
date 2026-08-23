// The waterfall's time axis, with the idle removed.
//
// A session that a human replied to twice is mostly nothing happening: without
// collapsing the gaps, ~70% of the waterfall is empty and every bar is a
// hairline. Collapsing maps absolute time onto a shorter axis by subtracting the
// gaps the user chose to hide, which keeps the bars proportional to each other
// while the axis reads in cumulative active time.

import { formatDurationAtStep } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"

import type { IdleGap } from "./session-summary"

export interface AxisTick {
	/** Position along the axis, 0…1. */
	readonly fraction: number
	readonly label: string
}

export interface SessionAxis {
	/** Axis length: wall clock minus every collapsed gap. */
	readonly totalMs: number
	readonly removedMs: number
	readonly removedGapCount: number
	readonly ticks: readonly AxisTick[]
	/** Absolute instant → 0…1 position along the axis. */
	readonly fraction: (ms: number) => number
}

const AXIS_TICK_TARGET = 6

// Session-scale tick ladder: the 1/2/5 decade steps up to a minute, then the
// clock values a wall-clock ruler wants. Deliberately NOT shared with the trace
// waterfall's `niceIntervalAtLeast` — extending that ladder would change the
// core trace ruler's output as a side effect of this page.
const NICE_STEPS_MS = [
	100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
	1_800_000, 3_600_000,
]

/** Snap up to the nearest nice step — never down, or the tick count overshoots the target. */
function niceStepAtLeast(raw: number): number {
	for (const nice of NICE_STEPS_MS) {
		if (nice >= raw) return nice
	}
	// Past the ladder (sessions that wait on a human): keep stepping by whole hours.
	const hour = 3_600_000
	return Math.max(hour, Math.ceil(raw / hour) * hour)
}

export function buildSessionAxis(options: {
	readonly startMs: number
	readonly endMs: number
	/**
	 * The gaps to remove; they must be disjoint. The caller decides which — an
	 * expanded gap is simply absent.
	 */
	readonly collapsedGaps: readonly IdleGap[]
}): SessionAxis {
	const { startMs, endMs } = options
	const collapsedGaps = [...options.collapsedGaps].sort((a, b) => a.startMs - b.startMs)
	const removedMs = collapsedGaps.reduce((total, gap) => total + gap.durationMs, 0)
	// A one-millisecond floor rather than a guard at every call site: a session
	// with no measurable duration would otherwise make every fraction NaN.
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
		totalMs,
		removedMs,
		removedGapCount: collapsedGaps.length,
		ticks: axisTicks(totalMs),
		fraction: (ms) => toAxisMs(ms) / totalMs,
	}
}

function axisTicks(totalMs: number): readonly AxisTick[] {
	const step = niceStepAtLeast(totalMs / (AXIS_TICK_TARGET - 1))
	const ticks: AxisTick[] = []
	for (let i = 0, count = Math.floor(totalMs / step); i <= count; i++) {
		const axisMs = i * step
		ticks.push({ fraction: axisMs / totalMs, label: tickLabel(axisMs, step) })
	}
	return ticks
}

// Under a minute the step sets the precision, so a two-second session still
// steps in halves; past it the session formatter reads the same as the durations
// in the rows below.
function tickLabel(axisMs: number, stepMs: number): string {
	if (axisMs <= 0) return "0s"
	return axisMs < 60_000 ? formatDurationAtStep(axisMs, stepMs) : formatSessionDuration(axisMs)
}
