import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange, ServiceHealthOutput } from "./types"

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

    // Aggregate service overview rows
    const svcRows = (overviewResult.data as any[]).filter(
      (r) => r.serviceName === input.serviceName,
    )
    let throughput = 0, errorCount = 0
    let weightedP50 = 0, weightedP95 = 0, weightedP99 = 0
    for (const r of svcRows) {
      const tp = Number(r.throughput)
      throughput += tp
      errorCount += Number(r.errorCount)
      weightedP50 += (r.p50LatencyMs ?? 0) * tp
      weightedP95 += (r.p95LatencyMs ?? 0) * tp
      weightedP99 += (r.p99LatencyMs ?? 0) * tp
    }
    const errorRate = throughput > 0 ? (errorCount / throughput) * 100 : 0

    // Compute average Apdex
    const apdexValues = (apdexResult.data as any[]).filter((a) => Number(a.totalCount) > 0)
    const avgApdex = apdexValues.length > 0
      ? apdexValues.reduce((sum, a) => sum + a.apdexScore, 0) / apdexValues.length
      : 0

    return {
      serviceName: input.serviceName,
      timeRange: input.timeRange,
      health: {
        throughput,
        errorRate,
        errorCount,
        p50Ms: throughput > 0 ? weightedP50 / throughput : 0,
        p95Ms: throughput > 0 ? weightedP95 / throughput : 0,
        p99Ms: throughput > 0 ? weightedP99 / throughput : 0,
        apdex: avgApdex,
      },
      topErrors: (errorsResult.data as any[]).map((e) => ({
        errorType: e.errorType,
        count: Number(e.count),
      })),
      recentTraces: (tracesResult.data as any[]).map((t) => ({
        traceId: t.traceId,
        rootSpanName: t.rootSpanName,
        durationMs: Number(t.durationMicros) / 1000,
        hasError: Boolean(Number(t.hasError)),
      })),
      recentLogs: (logsResult.data as any[]).map((l) => ({
        timestamp: String(l.timestamp),
        severityText: l.severityText || "INFO",
        serviceName: l.serviceName,
        body: l.body,
        traceId: l.traceId ?? "",
        spanId: l.spanId ?? "",
      })),
    }
  })
