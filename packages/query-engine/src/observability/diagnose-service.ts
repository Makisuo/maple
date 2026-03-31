import { Array as Arr, Effect, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange, ServiceHealthOutput } from "./types"
import { toLogEntry } from "./row-mappers"
import { aggregateServiceRows, weightedAvg } from "./aggregation"

export const diagnoseService = (input: {
  readonly serviceName: string
  readonly timeRange: TimeRange
  readonly environment?: string
}): Effect.Effect<ServiceHealthOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const envFilter = input.environment ? { deployment_envs: input.environment } : {}

    const [overviewResult, errorsResult, logsResult, tracesResult, apdexResult] =
      yield* Effect.all(
        [
          executor.query("service_overview", {
            start_time: input.timeRange.startTime,
            end_time: input.timeRange.endTime,
            ...(input.environment && { environments: input.environment }),
          }),
          executor.query("errors_by_type", {
            start_time: input.timeRange.startTime,
            end_time: input.timeRange.endTime,
            services: input.serviceName,
            limit: 10,
            ...envFilter,
          }),
          executor.query("list_logs", {
            start_time: input.timeRange.startTime,
            end_time: input.timeRange.endTime,
            service: input.serviceName,
            limit: 15,
          }),
          executor.query("list_traces", {
            start_time: input.timeRange.startTime,
            end_time: input.timeRange.endTime,
            service: input.serviceName,
            limit: 5,
          }),
          executor.query("service_apdex_time_series", {
            service_name: input.serviceName,
            start_time: input.timeRange.startTime,
            end_time: input.timeRange.endTime,
            bucket_seconds: 300,
          }),
        ],
        { concurrency: "unbounded" },
      )

    const agg = aggregateServiceRows(overviewResult.data as any[], input.serviceName)
    const errorRate = agg.throughput > 0 ? (agg.errorCount / agg.throughput) * 100 : 0

    const avgApdex = pipe(
      apdexResult.data as any[],
      Arr.filter((a) => Number(a.totalCount) > 0),
      (vals) => vals.length > 0
        ? Arr.reduce(vals, 0, (sum, a) => sum + a.apdexScore) / vals.length
        : 0,
    )

    return {
      serviceName: input.serviceName,
      timeRange: input.timeRange,
      health: {
        throughput: agg.throughput,
        errorRate,
        errorCount: agg.errorCount,
        p50Ms: weightedAvg(agg.weightedP50, agg.throughput),
        p95Ms: weightedAvg(agg.weightedP95, agg.throughput),
        p99Ms: weightedAvg(agg.weightedP99, agg.throughput),
        apdex: avgApdex,
      },
      topErrors: pipe(
        errorsResult.data as any[],
        Arr.map((e) => ({ errorType: e.errorType, count: Number(e.count) })),
      ),
      recentTraces: pipe(
        tracesResult.data as any[],
        Arr.map((t) => ({
          traceId: t.traceId,
          rootSpanName: t.rootSpanName,
          durationMs: Number(t.durationMicros) / 1000,
          hasError: Boolean(Number(t.hasError)),
        })),
      ),
      recentLogs: pipe(logsResult.data as any[], Arr.map(toLogEntry)),
    }
  })
