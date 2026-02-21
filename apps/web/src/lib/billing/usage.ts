import type { ServiceUsage } from "@/api/tinybird/service-usage"

const BYTES_PER_KB = 1_000

export interface AggregatedUsage {
  logsKB: number
  tracesKB: number
  metricsKB: number
}

export function aggregateUsage(services: ServiceUsage[]): AggregatedUsage {
  return services.reduce<AggregatedUsage>(
    (acc, s) => ({
      logsKB: acc.logsKB + s.logSizeBytes / BYTES_PER_KB,
      tracesKB: acc.tracesKB + s.traceSizeBytes / BYTES_PER_KB,
      metricsKB: acc.metricsKB + s.metricSizeBytes / BYTES_PER_KB,
    }),
    { logsKB: 0, tracesKB: 0, metricsKB: 0 },
  )
}

export function usagePercentage(usedKB: number, limitKB: number): number {
  if (limitKB === Infinity) return 0
  if (limitKB === 0) return 100
  return (usedKB / limitKB) * 100
}

export function formatUsage(kb: number): string {
  if (kb < 1) return "0 KB"
  if (kb < 1_000) return `${kb.toFixed(0)} KB`
  if (kb < 1_000_000) return `${(kb / 1_000).toFixed(0)} MB`
  return `${(kb / 1_000_000).toFixed(2)} GB`
}
