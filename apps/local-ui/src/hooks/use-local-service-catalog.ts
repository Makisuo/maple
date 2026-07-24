import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

export interface ServiceCatalogFilters {
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `service.namespace` resource attribute. */
	ns?: string
	/** Substring match on the service name (toolbar search, client-side). */
	search?: string
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

export interface ServiceCatalogEntry {
	serviceName: string
	serviceNamespaces: readonly string[]
	deploymentEnvironments: readonly string[]
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	/** Log/trace volume from the usage rollup (0 when the service has none). */
	logCount: number
}

export interface ServiceCatalogData {
	entries: ServiceCatalogEntry[]
	envFacets: Array<{ name: string; count: number }>
	nsFacets: Array<{ name: string; count: number }>
	totalErrorCount: number
}

/**
 * Service catalog for the services list — one query over the
 * `service_overview_spans` entry-point rollup plus the usage rollup for log
 * volume. Facets derive from the (small) catalog result client-side.
 */
export function useLocalServiceCatalog(filters: ServiceCatalogFilters) {
	return useQuery({
		queryKey: ["local", "services", "catalog", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ServiceCatalogData> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const params = { orgId: LOCAL_ORG_ID, startTime, endTime }
			const [catalogRows, usageRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(
						CH.serviceCatalogQuery({
							deploymentEnvironment: filters.env,
							serviceNamespace: filters.ns,
							limit: 200,
						}),
						params,
					),
				),
				executeLocalCompiledQuery(CH.compile(CH.serviceUsageQuery({}), params)),
			])

			const logsByService = new Map(
				usageRows.map((row) => [row.serviceName, Number(row.totalLogCount)]),
			)

			const all = catalogRows.map((row): ServiceCatalogEntry => {
				const spanCount = Number(row.estimatedSpanCount) || Number(row.spanCount)
				const errorCount = Number(row.estimatedErrorCount) || Number(row.errorCount)
				return {
					serviceName: row.serviceName,
					serviceNamespaces: row.serviceNamespaces,
					deploymentEnvironments: row.deploymentEnvironments,
					spanCount,
					errorCount,
					errorRate: spanCount > 0 ? errorCount / spanCount : 0,
					p50LatencyMs: Number(row.p50LatencyMs),
					p95LatencyMs: Number(row.p95LatencyMs),
					p99LatencyMs: Number(row.p99LatencyMs),
					logCount: logsByService.get(row.serviceName) ?? 0,
				}
			})

			const entries = filters.search
				? all.filter((e) => e.serviceName.toLowerCase().includes(filters.search!.toLowerCase()))
				: all

			const countBy = (pick: (e: ServiceCatalogEntry) => readonly string[]) => {
				const counts = new Map<string, number>()
				for (const entry of all) {
					for (const name of pick(entry)) {
						counts.set(name, (counts.get(name) ?? 0) + 1)
					}
				}
				return [...counts.entries()]
					.map(([name, count]) => ({ name, count }))
					.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
			}

			return {
				entries,
				envFacets: countBy((e) => e.deploymentEnvironments),
				nsFacets: countBy((e) => e.serviceNamespaces),
				totalErrorCount: entries.reduce((sum, e) => sum + e.errorCount, 0),
			}
		},
	})
}
