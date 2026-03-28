import { Effect } from "effect"
import type { DataSourceEndpoint } from "@/components/dashboard-builder/types"

import { getServiceUsage } from "@/api/tinybird/service-usage"
import {
  getServiceOverview,
  getServiceApdexTimeSeries,
  getServicesFacets,
} from "@/api/tinybird/services"
import { listTraces, getTracesFacets, getTracesDurationStats } from "@/api/tinybird/traces"
import { listLogs, getLogsCount, getLogsFacets } from "@/api/tinybird/logs"
import {
  getErrorsByType,
  getErrorsFacets,
  getErrorsSummary,
  getErrorDetailTraces,
} from "@/api/tinybird/errors"
import { getErrorRateByService } from "@/api/tinybird/error-rates"
import { listMetrics, getMetricTimeSeries, getMetricsSummary } from "@/api/tinybird/metrics"
import {
  getCustomChartTimeSeries,
  getCustomChartBreakdown,
  getCustomChartServiceSparklines,
} from "@/api/tinybird/custom-charts"
import { getQueryBuilderTimeseries } from "@/api/tinybird/query-builder-timeseries"
import { getQueryBuilderBreakdown } from "@/api/tinybird/query-builder-breakdown"
import { getQueryBuilderList } from "@/api/tinybird/query-builder-list"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerFunction = (opts: { data: any }) => Effect.Effect<any, unknown, unknown>

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
  metric_time_series_sum: getMetricTimeSeries,
  metric_time_series_gauge: getMetricTimeSeries,
  metric_time_series_histogram: getMetricTimeSeries,
  metric_time_series_exp_histogram: getMetricTimeSeries,
  custom_timeseries: getCustomChartTimeSeries,
  custom_breakdown: getCustomChartBreakdown,
  custom_query_builder_timeseries: getQueryBuilderTimeseries,
  custom_query_builder_breakdown: getQueryBuilderBreakdown,
  custom_query_builder_list: getQueryBuilderList,
}
