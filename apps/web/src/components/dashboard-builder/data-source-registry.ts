import { Effect } from "effect"
import type { DataSourceEndpoint } from "@/components/dashboard-builder/types"
import type { BackendError, WarehouseApiError } from "@/api/warehouse/effect-utils"
import {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	QUERY_RESULT_ENDPOINTS,
	RAW_SQL_ENDPOINT,
} from "@maple/widgets/dashboard"

import { getServiceUsage } from "@/api/warehouse/service-usage"
import { getServiceOverview, getServiceApdexTimeSeries, getServicesFacets } from "@/api/warehouse/services"
import { listTraces, getTracesFacets, getTracesDurationStats } from "@/api/warehouse/traces"
import { listLogs, getLogsCount, getLogsFacets } from "@/api/warehouse/logs"
import {
	getErrorsByType,
	getErrorsFacets,
	getErrorsSummary,
	getErrorDetailTraces,
} from "@/api/warehouse/errors"
import { getErrorRateByService } from "@/api/warehouse/error-rates"
import { listMetrics, getMetricsSummary } from "@/api/warehouse/metrics"
import {
	getCustomChartTimeSeries,
	getCustomChartBreakdown,
	getCustomChartServiceSparklines,
} from "@/api/warehouse/custom-charts"
import { getQueryBuilderTimeseries } from "@/api/warehouse/query-builder-timeseries"
import { getQueryBuilderBreakdown } from "@/api/warehouse/query-builder-breakdown"
import { getQueryBuilderList } from "@/api/warehouse/query-builder-list"
import { getRawSqlChart } from "@/api/warehouse/raw-sql-chart"

/**
 * Error channel shared by every warehouse server function. They fail with the
 * `WarehouseApiError` union (decode / query / transform / invalid-input) or a
 * tagged `@maple/http/errors/*` backend error surfaced by the API client. The
 * requirement channel is `never` — each function self-provides its layers via
 * `runWarehouseQuery` / `executeQueryEngine`.
 */
type ServerFunctionError = WarehouseApiError | BackendError

// The success channel stays `any`: each endpoint resolves a distinct response
// shape, and the registry is consumed through a single structural `{ data }`
// accessor that does not depend on the concrete success type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerFunction = (opts: { data: any }) => Effect.Effect<any, ServerFunctionError, never>

const markdownStaticServerFn: ServerFunction = () => Effect.succeed({ data: null })

export const serverFunctionMap: Record<DataSourceEndpoint, ServerFunction> = {
	service_usage: getServiceUsage,
	service_overview: getServiceOverview,
	service_overview_time_series: getCustomChartServiceSparklines,
	service_apdex_time_series: getServiceApdexTimeSeries,
	services_facets: getServicesFacets,
	list_traces: listTraces,
	traces_facets: getTracesFacets,
	traces_duration_stats: getTracesDurationStats,
	list_logs: listLogs,
	logs_count: getLogsCount,
	logs_facets: getLogsFacets,
	errors_summary: getErrorsSummary,
	errors_by_type: getErrorsByType,
	error_detail_traces: getErrorDetailTraces,
	errors_facets: getErrorsFacets,
	error_rate_by_service: getErrorRateByService,
	list_metrics: listMetrics,
	metrics_summary: getMetricsSummary,
	custom_timeseries: getCustomChartTimeSeries,
	custom_breakdown: getCustomChartBreakdown,
	custom_query_builder_timeseries: getQueryBuilderTimeseries,
	custom_query_builder_breakdown: getQueryBuilderBreakdown,
	custom_query_builder_list: getQueryBuilderList,
	raw_sql_chart: getRawSqlChart,
	markdown_static: markdownStaticServerFn,
} satisfies Record<DataSourceEndpoint, ServerFunction>

/**
 * Looks up a data-source server function by endpoint name. Accepts an
 * arbitrary string (e.g. an endpoint coming from a JSON-decoded widget config
 * whose type is only `string`) and returns `undefined` for unknown endpoints.
 */
export function getServerFunction(endpoint: string): ServerFunction | undefined {
	return Object.prototype.hasOwnProperty.call(serverFunctionMap, endpoint)
		? serverFunctionMap[endpoint as DataSourceEndpoint]
		: undefined
}

/**
 * A stored data source, resolved to the request the fetch layer sends.
 *
 * The single place the web app turns "what this widget is" into "which server
 * function, with which params". Everything downstream of it — the atom family
 * key, the retention namespace, `fetchWidgetData`'s dispatch — stays keyed by
 * endpoint string, because that string is the transport identity and works
 * unchanged either way.
 *
 * It is also the one function the v3 flip touches on the read path: a
 * `kind: "query"` data source has no endpoint of its own, so its result shape is
 * mapped onto the server function that already serves that shape. Returns null
 * for a data source nothing can serve, which the caller reports as a disabled
 * tile rather than a failed fetch.
 */
export function toWidgetRequest(
	dataSource: unknown,
): { endpoint: string; params: Record<string, unknown> } | null {
	const rawSql = dataSourceRawSql(dataSource)
	if (rawSql !== null) {
		return {
			endpoint: RAW_SQL_ENDPOINT,
			params: {
				sql: rawSql.sql,
				...(!(rawSql.displayType === undefined) ? { displayType: rawSql.displayType } : undefined),
				...(!(rawSql.granularitySeconds === undefined)
					? {
							granularitySeconds: rawSql.granularitySeconds,
						}
					: undefined),
			},
		}
	}

	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null) {
		return {
			endpoint: QUERY_RESULT_ENDPOINTS[querySet.resultShape],
			params: {
				queries: querySet.queries,
				...(!(querySet.formulas === undefined) ? { formulas: querySet.formulas } : undefined),
				...(!(querySet.comparison === undefined) ? { comparison: querySet.comparison } : undefined),
				...(!(querySet.defaultLimit === undefined)
					? { defaultLimit: querySet.defaultLimit }
					: undefined),
				...(!(querySet.limit === undefined) ? { limit: querySet.limit } : undefined),
				...(!(querySet.columns === undefined) ? { columns: querySet.columns } : undefined),
			},
		}
	}

	const endpoint = dataSourceEndpoint(dataSource)
	if (endpoint === null) return null
	return { endpoint, params: dataSourceRouteParams(dataSource) ?? {} }
}
