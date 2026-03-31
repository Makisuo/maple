import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { ListServicesInput, ServiceSummary } from "./types"

export const listServices = (
  input: ListServicesInput,
): Effect.Effect<ReadonlyArray<ServiceSummary>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query("service_overview", {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.environment && { environments: input.environment }),
    })

    // Aggregate by service name (collapse environment/commit dimensions)
    const serviceMap = new Map<string, {
      throughput: number
      errorCount: number
      weightedP50: number
      weightedP95: number
      weightedP99: number
      totalWeight: number
    }>()

    for (const row of result.data as any[]) {
      const tp = Number(row.throughput)
      const existing = serviceMap.get(row.serviceName)
      if (existing) {
        existing.throughput += tp
        existing.errorCount += Number(row.errorCount)
        existing.weightedP50 += (row.p50LatencyMs ?? 0) * tp
        existing.weightedP95 += (row.p95LatencyMs ?? 0) * tp
        existing.weightedP99 += (row.p99LatencyMs ?? 0) * tp
        existing.totalWeight += tp
      } else {
        serviceMap.set(row.serviceName, {
          throughput: tp,
          errorCount: Number(row.errorCount),
          weightedP50: (row.p50LatencyMs ?? 0) * tp,
          weightedP95: (row.p95LatencyMs ?? 0) * tp,
          weightedP99: (row.p99LatencyMs ?? 0) * tp,
          totalWeight: tp,
        })
      }
    }

    return Array.from(serviceMap.entries())
      .sort(([, a], [, b]) => b.throughput - a.throughput)
      .map(([name, svc]): ServiceSummary => ({
        name,
        throughput: svc.throughput,
        errorCount: svc.errorCount,
        errorRate: svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0,
        p50Ms: svc.totalWeight > 0 ? svc.weightedP50 / svc.totalWeight : 0,
        p95Ms: svc.totalWeight > 0 ? svc.weightedP95 / svc.totalWeight : 0,
        p99Ms: svc.totalWeight > 0 ? svc.weightedP99 / svc.totalWeight : 0,
      }))
  })
