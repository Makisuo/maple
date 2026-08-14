/**
 * Choosing the bucket width and the windows a query set actually executes over.
 *
 * Pure. The empty-range fallback lives here rather than in the runner because it
 * is a *policy* — see `EmptyRangeFallbackStrategy` below for why it is opt-in.
 */

import type { QuerySpec } from "@maple/domain/query-engine"
import { computeBucketSecondsForRange, formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"

export interface ExecutionWindow {
	readonly startTime: string
	readonly endTime: string
	readonly kind: "primary" | "fallback"
}

/**
 * Widen the window and retry when the requested range came back empty.
 *
 * OPT-IN, and off unless a caller asks — which matches what already happens:
 * every dashboard tile passes `enableEmptyRangeFallback: false`, so only the
 * query-builder lab and the metric detail page ever use it. Those are explore
 * surfaces, where "show me the most recent data that exists" is the useful
 * answer to an empty window.
 *
 * It must never reach alert evaluation. An alert's window IS its semantics:
 * silently evaluating 24h because the last 5 minutes were empty would breach or
 * clear on data outside the rule's window, would break `minimumSampleCount`
 * (which counts samples in the rule window), and would make
 * `noDataBehavior: "zero"` unreachable — "the window is empty" is exactly the
 * signal a throughput-drop alert exists to catch. That is enforced structurally:
 * nothing on the alert path takes this type.
 */
export interface EmptyRangeFallbackStrategy {
	readonly enabled: boolean
	readonly windowSeconds: ReadonlyArray<number>
	readonly maxRangeSeconds: number
}

/** No widening: what every dashboard tile already asks for. */
export const NO_EMPTY_RANGE_FALLBACK: EmptyRangeFallbackStrategy = {
	enabled: false,
	windowSeconds: [],
	maxRangeSeconds: 0,
}

/** The 24h → 7d → 31d ladder the explore surfaces use. */
export const LAB_EMPTY_RANGE_STRATEGY: EmptyRangeFallbackStrategy = {
	enabled: true,
	windowSeconds: [24 * 60 * 60, 7 * 24 * 60 * 60, 31 * 24 * 60 * 60],
	maxRangeSeconds: 31 * 24 * 60 * 60,
}

/** Normalize a partially-specified strategy: drop non-positive rungs, sort, dedupe. */
export function resolveFallbackStrategy(
	input:
		| {
				readonly enabled?: boolean
				readonly windowSeconds?: ReadonlyArray<number>
				readonly maxRangeSeconds?: number
		  }
		| undefined,
	base: EmptyRangeFallbackStrategy = LAB_EMPTY_RANGE_STRATEGY,
): EmptyRangeFallbackStrategy {
	const uniqueWindows = new Set(
		(input?.windowSeconds ?? base.windowSeconds).filter(
			(seconds) => Number.isFinite(seconds) && seconds > 0,
		),
	)

	return {
		enabled: input?.enabled ?? base.enabled,
		windowSeconds: Array.from(uniqueWindows).sort((left, right) => left - right),
		maxRangeSeconds: input?.maxRangeSeconds ?? base.maxRangeSeconds,
	}
}

/** Fill in `bucketSeconds` from the range when the lowering left it unset. */
export function resolveTimeseriesBucketSpec(spec: QuerySpec, startTime: string, endTime: string): QuerySpec {
	if (spec.kind !== "timeseries" || spec.bucketSeconds) {
		return spec
	}

	return {
		...spec,
		bucketSeconds: computeBucketSecondsForRange(startTime, endTime, "chart"),
	} satisfies QuerySpec
}

/**
 * The spec for one execution window.
 *
 * A fallback window is wider than the primary, so it takes the COARSER of the
 * two bucket widths — reusing the primary's width over a 31-day window would ask
 * for tens of thousands of points.
 */
export function resolveExecutionSpecForWindow(spec: QuerySpec, window: ExecutionWindow): QuerySpec {
	const resolved = resolveTimeseriesBucketSpec(spec, window.startTime, window.endTime)
	if (resolved.kind !== "timeseries") {
		return resolved
	}

	if (window.kind !== "fallback") {
		return resolved
	}

	const autoBucketSeconds = computeBucketSecondsForRange(window.startTime, window.endTime, "chart")
	const selectedBucketSeconds = Math.max(resolved.bucketSeconds ?? autoBucketSeconds, autoBucketSeconds)
	return {
		...resolved,
		bucketSeconds: selectedBucketSeconds,
	}
}

/**
 * The ordered windows to try: the requested one, then progressively wider ones
 * if the strategy allows. Always at least the primary.
 */
export function buildExecutionWindows(
	startTime: string,
	endTime: string,
	strategy: EmptyRangeFallbackStrategy,
	allowFallback: boolean,
): ExecutionWindow[] {
	const startMs = parseWarehouseDateTime(startTime)
	const endMs = parseWarehouseDateTime(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
		return [{ startTime, endTime, kind: "primary" }]
	}

	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const windows: ExecutionWindow[] = [{ startTime, endTime, kind: "primary" }]

	if (!allowFallback || !strategy.enabled) {
		return windows
	}

	const seen = new Set([`${startTime}|${endTime}`])
	for (const seconds of strategy.windowSeconds) {
		// Only ever widen, and never past the ceiling.
		if (seconds <= rangeSeconds || seconds > strategy.maxRangeSeconds) {
			continue
		}

		const windowStartMs = endMs - seconds * 1000
		const nextStart = formatWarehouseDateTime(windowStartMs)
		const nextEnd = formatWarehouseDateTime(endMs)
		const key = `${nextStart}|${nextEnd}`

		if (seen.has(key)) {
			continue
		}

		seen.add(key)
		windows.push({
			startTime: nextStart,
			endTime: nextEnd,
			kind: "fallback",
		})
	}

	return windows
}
