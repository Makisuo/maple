import { Array as Arr, pipe } from "effect"

interface ServiceOverviewRow {
  readonly serviceName: string
  readonly throughput: number | string
  readonly errorCount: number | string
  readonly p50LatencyMs?: number
  readonly p95LatencyMs?: number
  readonly p99LatencyMs?: number
}

interface AggregatedService {
  readonly throughput: number
  readonly errorCount: number
  readonly weightedP50: number
  readonly weightedP95: number
  readonly weightedP99: number
}

export const aggregateServiceRows = (
  rows: ReadonlyArray<any>,
  serviceName?: string,
): AggregatedService => {
  const filtered = serviceName
    ? pipe(rows, Arr.filter((r: any) => r.serviceName === serviceName))
    : rows

  return pipe(
    filtered,
    Arr.reduce(
      { throughput: 0, errorCount: 0, weightedP50: 0, weightedP95: 0, weightedP99: 0 },
      (acc, r: any) => {
        const tp = Number(r.throughput)
        return {
          throughput: acc.throughput + tp,
          errorCount: acc.errorCount + Number(r.errorCount),
          weightedP50: acc.weightedP50 + (r.p50LatencyMs ?? 0) * tp,
          weightedP95: acc.weightedP95 + (r.p95LatencyMs ?? 0) * tp,
          weightedP99: acc.weightedP99 + (r.p99LatencyMs ?? 0) * tp,
        }
      },
    ),
  )
}

export const weightedAvg = (weighted: number, total: number): number =>
  total > 0 ? weighted / total : 0
