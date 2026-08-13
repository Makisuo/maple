import { Array as Arr, pipe } from "effect"
import type { ServiceOverviewOutput } from "@maple/domain/tinybird"

export interface AggregatedService {
	readonly throughput: number
	readonly errorCount: number
	readonly weightedP50: number
	readonly weightedP95: number
	readonly weightedP99: number
}

/**
 * Collapse `service_overview` rows to one entry per service name.
 *
 * The latency fields are a throughput-weighted MEAN of each row's quantiles,
 * which is an approximation, not a quantile. It is bounded now in a way it was
 * not before: `serviceOverviewQuery` already merges the tDigest states down to
 * one row per (service, environment), so the only remaining averaging is ACROSS
 * environments — and for the common single-environment service there is nothing
 * left to average and the value is exact.
 *
 * Removing the approximation entirely means reading `serviceCatalogQuery`, which
 * merges the states at name level. That is a pipe/route change for the MCP and
 * v2 surfaces rather than a swap here, so it is deliberately not done in this
 * pass.
 */
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
