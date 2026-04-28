import { Array as Arr, pipe } from "effect"
import type { ServiceOverviewOutput } from "@maple/domain/tinybird"

export interface AggregatedService {
	readonly throughput: number
	readonly errorCount: number
	readonly weightedP50: number
	readonly weightedP95: number
	readonly weightedP99: number
}

export const aggregateServiceRows = (
	rows: ReadonlyArray<ServiceOverviewOutput>,
	serviceName?: string,
): AggregatedService => {
	const filtered = serviceName
		? pipe(
				rows,
				Arr.filter((r) => r.serviceName === serviceName),
			)
		: rows

	return pipe(
		filtered,
		Arr.reduce(
			{
				throughput: 0,
				errorCount: 0,
				weightedP50: 0,
				weightedP95: 0,
				weightedP99: 0,
			} as AggregatedService,
			(acc, r) => {
				const tp = Number(r.throughput)
				return {
					throughput: acc.throughput + tp,
					errorCount: acc.errorCount + Number(r.errorCount),
					weightedP50: acc.weightedP50 + r.p50LatencyMs * tp,
					weightedP95: acc.weightedP95 + r.p95LatencyMs * tp,
					weightedP99: acc.weightedP99 + r.p99LatencyMs * tp,
				}
			},
		),
	)
}

export const weightedAvg = (weighted: number, total: number): number => (total > 0 ? weighted / total : 0)
