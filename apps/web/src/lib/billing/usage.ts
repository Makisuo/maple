import type { ServiceUsage } from "@/api/tinybird/service-usage"

const BYTES_PER_GB = 1_000_000_000

export interface AggregatedUsage {
  logsGB: number
  tracesGB: number
  metricsGB: number
}

export function aggregateUsage(services: ServiceUsage[]): AggregatedUsage {
  return services.reduce<AggregatedUsage>(
    (acc, s) => ({
      logsGB: acc.logsGB + s.logSizeBytes / BYTES_PER_GB,
      tracesGB: acc.tracesGB + s.traceSizeBytes / BYTES_PER_GB,
      metricsGB: acc.metricsGB + s.metricSizeBytes / BYTES_PER_GB,
    }),
    { logsGB: 0, tracesGB: 0, metricsGB: 0 },
  )
}

export function usagePercentage(usedGB: number, limitGB: number): number {
  if (limitGB === Infinity) return 0
  if (limitGB === 0) return 100
  return (usedGB / limitGB) * 100
}

export function formatUsage(gb: number): string {
  if (gb < 0.01) return "0 GB"
  if (gb < 1) return `${(gb * 1000).toFixed(2)} MB`
  return `${gb.toFixed(2)} GB`
}
