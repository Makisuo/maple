import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import type { DurationStats } from "@maple/ui/components/filters/duration-range-filter"
import type { TraceFilters } from "./use-local-traces"

export type { DurationStats }

export interface TraceFacets {
	services: FilterOption[]
	spanNames: FilterOption[]
	httpMethods: FilterOption[]
	httpStatusCodes: FilterOption[]
	deploymentEnvs: FilterOption[]
	namespaces: FilterOption[]
	errorCount: number
	durationStats?: DurationStats
}

/**
 * Facet counts + duration stats for the traces sidebar, scoped to the active
 * filters. Deliberate deviation from the web app (which computes facets over
 * the bare time range): we pass the full filter set into the union query so
 * counts reflect the current selection. Side effect: a selected facet narrows
 * its own section to the chosen value — fine for single-select, unchecking
 * restores the full list.
 */
export function useLocalTraceFacets(filters: TraceFilters) {
	return useQuery<TraceFacets>({
		queryKey: ["local", "trace-facets", filters],
		staleTime: 15_000,
		placeholderData: keepPreviousData,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const params = { orgId: LOCAL_ORG_ID, startTime, endTime }
			const opts: CH.TracesFacetsOpts = {
				serviceName: filters.service,
				spanName: filters.span ?? filters.search,
				matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
				hasError: filters.errorsOnly || undefined,
				httpMethod: filters.method,
				httpStatusCode: filters.status,
				deploymentEnv: filters.env,
				namespace: filters.ns,
				minDurationMs: filters.minDurationMs,
				maxDurationMs: filters.maxDurationMs,
			}
			const [facetRows, statsRows] = await Promise.all([
				executeLocalCompiledQuery(CH.compileUnion(CH.tracesFacetsQuery(opts), params)),
				executeLocalCompiledQuery(CH.compile(CH.tracesDurationStatsQuery(opts), params)),
			])

			const byType = (facetType: string): FilterOption[] =>
				facetRows
					.filter((row) => row.facetType === facetType && row.name)
					.map((row) => ({ name: row.name, count: Number(row.count) }))

			return {
				services: byType("service"),
				spanNames: byType("spanName"),
				httpMethods: byType("httpMethod"),
				httpStatusCodes: byType("httpStatus"),
				deploymentEnvs: byType("deploymentEnv"),
				namespaces: byType("serviceNamespace"),
				errorCount: Number(facetRows.find((row) => row.facetType === "errorCount")?.count ?? 0),
				durationStats: toDurationStats(statsRows[0]),
			}
		},
	})
}

/**
 * An empty window yields a zero/NaN aggregate row (ClickHouse encodes NaN
 * quantiles as null in JSON) — drop the stats instead of rendering bogus hints.
 */
function toDurationStats(row: CH.TracesDurationStatsOutput | undefined): DurationStats | undefined {
	if (!row) return undefined
	const stats = {
		minDurationMs: Number(row.minDurationMs),
		maxDurationMs: Number(row.maxDurationMs),
		p50DurationMs: Number(row.p50DurationMs),
		p95DurationMs: Number(row.p95DurationMs),
	}
	const values = Object.values(stats)
	if (values.some((v) => !Number.isFinite(v)) || stats.maxDurationMs <= 0) return undefined
	return stats
}
