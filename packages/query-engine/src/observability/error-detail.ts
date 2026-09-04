import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorDetailTracesOutput, ErrorsTimeseriesOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { parseWarehouseDateTime, formatWarehouseDateTime } from "../datetime"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { TimeRange } from "./types"

const LOG_WINDOW_HALF_WIDTH_MS = 60 * 60 * 1000

/**
 * ±1h window around a trace's start time. A trace's logs share its timestamps,
 * so bounding `list_logs` lets ClickHouse prune partitions — without a range,
 * pipe-dispatch falls back to an all-time sentinel window (2023→2099) and the
 * lookup scans full retention (mined at p95 ~5s on busy orgs).
 */
const logRangeAround = (traceStartTime: string): { start_time: string; end_time: string } | undefined => {
	const ms = parseWarehouseDateTime(traceStartTime)
	if (Number.isNaN(ms)) return undefined
	return {
		start_time: formatWarehouseDateTime(ms - LOG_WINDOW_HALF_WIDTH_MS),
		end_time: formatWarehouseDateTime(ms + LOG_WINDOW_HALF_WIDTH_MS),
	}
}

/** The span that failed, with the handful of attributes that identify what it was doing. */
export interface ErrorDetailSpan {
	readonly spanId: string
	readonly name: string
	readonly serviceName: string
	readonly statusMessage: string
	readonly attributes: Readonly<Record<string, string>>
}

export interface ErrorDetailTrace {
	readonly traceId: string
	readonly rootSpanName: string
	readonly durationMs: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly startTime: string
	readonly errorMessage: string
	readonly errorSpan: ErrorDetailSpan | undefined
	readonly logs: ReadonlyArray<{ timestamp: string; severityText: string; body: string }>
}

const errorSpanOf = (t: ErrorDetailTracesOutput): ErrorDetailSpan | undefined => {
	if (!t.errorSpanId) return undefined
	const attributes: Record<string, string> = {}
	const attr = (key: string, value: string | undefined) => {
		if (value) attributes[key] = value
	}
	attr("gen_ai.request.model", t.errorModel)
	attr("gen_ai.tool.name", t.errorToolName)
	attr("http.request.method", t.errorHttpMethod)
	attr("http.route", t.errorHttpRoute)
	attr("query.context", t.errorQueryContext)
	attr("error.type", t.errorType)
	return {
		spanId: t.errorSpanId,
		name: t.errorSpanName ?? "",
		serviceName: t.errorServiceName ?? "",
		statusMessage: t.errorMessage ?? "",
		attributes,
	}
}

export interface ErrorDetailOutput {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	readonly traces: ReadonlyArray<ErrorDetailTrace>
	readonly timeseries?: ReadonlyArray<{ bucket: string; count: number }>
}

export const errorDetail = Effect.fn("Observability.errorDetail")(function* (input: {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	readonly service?: string
	readonly includeTimeseries?: boolean
	readonly limit?: number
}) {
	const executor = yield* WarehouseExecutor
	const limit = input.limit ?? 5

	yield* Effect.annotateCurrentSpan({
		fingerprintHash: input.fingerprintHash,
		service: input.service ?? "all",
	})

	const tracesResult = yield* executor.query<ErrorDetailTracesOutput>(
		"error_detail_traces",
		{
			fingerprint_hash: input.fingerprintHash,
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { services: input.service }),
			limit,
		},
		{ profile: "list" },
	)

	const traces = tracesResult.data
	yield* Effect.annotateCurrentSpan("traceCount", traces.length)

	const logsResults = yield* pipe(
		traces,
		Arr.take(3),
		Effect.forEach(
			(t) =>
				executor.query<ListLogsOutput>(
					"list_logs",
					{
						trace_id: t.traceId,
						limit: 10,
						...(logRangeAround(t.startTime) ?? {
							start_time: input.timeRange.startTime,
							end_time: input.timeRange.endTime,
						}),
					},
					{ profile: "list" },
				),
			{ concurrency: "unbounded" },
		),
	)

	// Optionally fetch timeseries
	const timeseries = input.includeTimeseries
		? yield* executor
				.query<ErrorsTimeseriesOutput>(
					"errors_timeseries",
					{
						fingerprint_hash: input.fingerprintHash,
						start_time: input.timeRange.startTime,
						end_time: input.timeRange.endTime,
						...(input.service && { services: input.service }),
					},
					{ profile: "aggregation" },
				)
				.pipe(
					Effect.map((r) =>
						pipe(
							r.data,
							Arr.map((p) => ({ bucket: String(p.bucket), count: Number(p.count) })),
						),
					),
				)
		: undefined

	return {
		fingerprintHash: input.fingerprintHash,
		timeRange: input.timeRange,
		traces: pipe(
			traces,
			Arr.map(
				(t, i): ErrorDetailTrace => ({
					traceId: t.traceId,
					rootSpanName: t.rootSpanName,
					// No `Number(...)` / `String(...)`: the row already decoded through
					// the compiled query's schema, which is what coerces the wire form.
					durationMs: t.durationMicros / 1000,
					spanCount: t.spanCount,
					services: t.services,
					startTime: t.startTime,
					errorMessage: t.errorMessage ?? "",
					errorSpan: errorSpanOf(t),
					logs: pipe(
						logsResults[i]?.data ?? [],
						Arr.take(5),
						Arr.map((l) => ({
							timestamp: String(l.timestamp),
							severityText: l.severityText || "INFO",
							body: l.body,
						})),
					),
				}),
			),
		),
		timeseries,
	}
})
