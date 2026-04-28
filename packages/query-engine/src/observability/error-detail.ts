import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorDetailTracesOutput, ErrorsTimeseriesOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange } from "./types"

export interface ErrorDetailTrace {
	readonly traceId: string
	readonly rootSpanName: string
	readonly durationMs: number
	readonly spanCount: number
	readonly services: string[]
	readonly startTime: string
	readonly errorMessage: string
	readonly logs: ReadonlyArray<{ timestamp: string; severityText: string; body: string }>
}

export interface ErrorDetailOutput {
	readonly errorType: string
	readonly timeRange: TimeRange
	readonly traces: ReadonlyArray<ErrorDetailTrace>
	readonly timeseries?: ReadonlyArray<{ bucket: string; count: number }>
}

export const errorDetail = (input: {
	readonly errorType: string
	readonly timeRange: TimeRange
	readonly service?: string
	readonly includeTimeseries?: boolean
	readonly limit?: number
}): Effect.Effect<ErrorDetailOutput, ObservabilityError, TinybirdExecutor> =>
	Effect.gen(function* () {
		const executor = yield* TinybirdExecutor
		const limit = input.limit ?? 5

		const tracesResult = yield* executor.query<ErrorDetailTracesOutput>(
			"error_detail_traces",
			{
				error_type: input.errorType,
				start_time: input.timeRange.startTime,
				end_time: input.timeRange.endTime,
				...(input.service && { services: input.service }),
				limit,
			},
			{ profile: "list" },
		)

		const traces = tracesResult.data

		// Fetch logs for first 3 traces in parallel
		const logsResults = yield* pipe(
			traces,
			Arr.take(3),
			Effect.forEach(
				(t) =>
					executor.query<ListLogsOutput>(
						"list_logs",
						{ trace_id: t.traceId, limit: 10 },
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
							error_type: input.errorType,
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
			errorType: input.errorType,
			timeRange: input.timeRange,
			traces: pipe(
				traces,
				Arr.map(
					(t, i): ErrorDetailTrace => ({
						traceId: t.traceId,
						rootSpanName: t.rootSpanName,
						durationMs: Number(t.durationMicros) / 1000,
						spanCount: Number(t.spanCount),
						services: t.services ?? [],
						startTime: String(t.startTime),
						errorMessage: t.errorMessage ?? "",
						logs: pipe(
							i < logsResults.length ? logsResults[i]!.data : [],
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
