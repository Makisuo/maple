import type { GetServiceOperationsInput } from "@/api/warehouse/service-operations"
import { normalizeTimestampInput } from "@/lib/timezone-format"

/** Matches the chart grid's density: ~50 buckets across the window, ≥1 minute. */
export const OPERATIONS_SPARKLINE_BUCKETS = 50
export const OPERATIONS_LIMIT = 25

export function windowSeconds(startTime: string, endTime: string): number {
	const start = new Date(normalizeTimestampInput(startTime)).getTime()
	const end = new Date(normalizeTimestampInput(endTime)).getTime()
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
	return Math.max(0, (end - start) / 1000)
}

export function operationsBucketSeconds(startTime: string, endTime: string): number {
	return Math.max(60, Math.floor(windowSeconds(startTime, endTime) / OPERATIONS_SPARKLINE_BUCKETS))
}

export function callsPerSecond(estimatedSpanCount: number, seconds: number): number {
	if (seconds <= 0) return 0
	return estimatedSpanCount / seconds
}

/**
 * The shared atom-family input for the operations query. The Overview panel and
 * the Operations tab both build their key through this, so opening the tab
 * after seeing the panel is a cache hit (the ServiceDependencyStrip trick).
 */
export function serviceOperationsQueryInput(args: {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: readonly string[]
}): GetServiceOperationsInput {
	return {
		serviceName: args.serviceName,
		startTime: args.effectiveStartTime,
		endTime: args.effectiveEndTime,
		environments: args.environments?.length ? args.environments : undefined,
		bucketSeconds: operationsBucketSeconds(args.effectiveStartTime, args.effectiveEndTime),
		limit: OPERATIONS_LIMIT,
	}
}

/**
 * Drill-down /traces search for one operation. Uses structured filters —
 * `spanNames` matches either the raw or display span-name spelling server-side.
 */
export function operationTraceSearch(args: {
	serviceName: string
	spanName: string
	environments?: readonly string[]
	startTime?: string
	endTime?: string
	timePreset?: string
}) {
	return {
		services: [args.serviceName],
		spanNames: [args.spanName],
		deploymentEnvs: args.environments?.length ? [...args.environments] : undefined,
		// The trace list defaults to root spans only; most operations are interior
		// spans, so drill-downs must search at span level or they come back empty.
		rootOnly: false,
		startTime: args.startTime,
		endTime: args.endTime,
		timePreset: args.timePreset,
	}
}
