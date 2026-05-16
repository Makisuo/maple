import { Effect } from "effect"
import type { DataSourceEndpoint } from "@/components/dashboard-builder/types"

import { getServiceUsage } from "@/api/tinybird/service-usage"
import { getServiceOverview, getServiceApdexTimeSeries, getServicesFacets } from "@/api/tinybird/services"
import { listTraces, getTracesFacets, getTracesDurationStats } from "@/api/tinybird/traces"
import { listLogs, getLogsCount, getLogsFacets } from "@/api/tinybird/logs"
import {
	getErrorsByType,
	getErrorsFacets,
	getErrorsSummary,
	getErrorDetailTraces,
} from "@/api/tinybird/errors"
import { getErrorRateByService } from "@/api/tinybird/error-rates"
import { listMetrics, getMetricsSummary } from "@/api/tinybird/metrics"
import {
	getCustomChartTimeSeries,
	getCustomChartBreakdown,
	getCustomChartServiceSparklines,
} from "@/api/tinybird/custom-charts"
import { getQueryBuilderTimeseries } from "@/api/tinybird/query-builder-timeseries"
import { getQueryBuilderBreakdown } from "@/api/tinybird/query-builder-breakdown"
import { getQueryBuilderList } from "@/api/tinybird/query-builder-list"
import { getRawSqlChart } from "@/api/tinybird/raw-sql-chart"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerFunction = (opts: { data: any }) => Effect.Effect<any, unknown, unknown>

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
}

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
