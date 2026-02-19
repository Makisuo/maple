import type { TinybirdPipe } from "@maple/domain"
import { Effect } from "effect"
import { MapleApiAtomClient } from "./services/common/atom-client"
import { setMapleAuthHeaders } from "./services/common/auth-headers"

import type {
  CustomLogsBreakdownOutput,
  CustomLogsTimeseriesOutput,
  CustomMetricsBreakdownOutput,
  CustomTracesBreakdownOutput,
  CustomTracesTimeseriesOutput,
  ErrorDetailTracesOutput,
  ErrorRateByServiceOutput,
  ErrorsByTypeOutput,
  ErrorsFacetsOutput,
  ErrorsSummaryOutput,
  GetServiceUsageOutput,
  ListLogsOutput,
  ListMetricsOutput,
  ListTracesOutput,
  LogsCountOutput,
  LogsFacetsOutput,
  MetricTimeSeriesExpHistogramOutput,
  MetricTimeSeriesGaugeOutput,
  MetricTimeSeriesHistogramOutput,
  MetricTimeSeriesSumOutput,
  MetricsSummaryOutput,
  ServiceApdexTimeSeriesOutput,
  ServiceDependenciesOutput,
  ServiceOverviewOutput,
  ServicesFacetsOutput,
  SpanAttributeKeysOutput,
  SpanAttributeValuesOutput,
  SpanHierarchyOutput,
  TracesDurationStatsOutput,
  TracesFacetsOutput,
} from "@/tinybird/endpoints"

export type {
  CustomLogsBreakdownParams,
  CustomLogsBreakdownOutput,
  CustomLogsTimeseriesParams,
  CustomLogsTimeseriesOutput,
  CustomMetricsBreakdownParams,
  CustomMetricsBreakdownOutput,
  CustomTracesBreakdownParams,
  CustomTracesBreakdownOutput,
  CustomTracesTimeseriesParams,
  CustomTracesTimeseriesOutput,
  ErrorDetailTracesParams,
  ErrorDetailTracesOutput,
  ErrorRateByServiceParams,
  ErrorRateByServiceOutput,
  ErrorsByTypeParams,
  ErrorsByTypeOutput,
  ErrorsFacetsParams,
  ErrorsFacetsOutput,
  ErrorsSummaryParams,
  ErrorsSummaryOutput,
  GetServiceUsageParams,
  GetServiceUsageOutput,
  ListLogsParams,
  ListLogsOutput,
  ListMetricsParams,
  ListMetricsOutput,
  ListTracesParams,
  ListTracesOutput,
  LogsCountParams,
  LogsCountOutput,
  LogsFacetsParams,
  LogsFacetsOutput,
  MetricTimeSeriesExpHistogramParams,
  MetricTimeSeriesExpHistogramOutput,
  MetricTimeSeriesGaugeParams,
  MetricTimeSeriesGaugeOutput,
  MetricTimeSeriesHistogramParams,
  MetricTimeSeriesHistogramOutput,
  MetricTimeSeriesSumParams,
  MetricTimeSeriesSumOutput,
  MetricsSummaryParams,
  MetricsSummaryOutput,
  ServiceApdexTimeSeriesParams,
  ServiceApdexTimeSeriesOutput,
  ServiceDependenciesParams,
  ServiceDependenciesOutput,
  ServiceOverviewParams,
  ServiceOverviewOutput,
  ServicesFacetsParams,
  ServicesFacetsOutput,
  SpanAttributeKeysParams,
  SpanAttributeKeysOutput,
  SpanAttributeValuesParams,
  SpanAttributeValuesOutput,
  SpanHierarchyParams,
  SpanHierarchyOutput,
  TracesDurationStatsParams,
  TracesDurationStatsOutput,
  TracesFacetsParams,
  TracesFacetsOutput,
} from "@/tinybird/endpoints"

type QueryResponse<T> = {
  data: T[]
}

export { setMapleAuthHeaders }

const queryTinybird = <T>(pipe: TinybirdPipe, params?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const client = yield* MapleApiAtomClient
    return (yield* client.tinybird.query({
      payload: {
        pipe,
        params,
      },
    })) as QueryResponse<T>
  })

const query = {
  list_traces: (params?: Record<string, unknown>) =>
    queryTinybird<ListTracesOutput>("list_traces", params),
  span_hierarchy: (params?: Record<string, unknown>) =>
    queryTinybird<SpanHierarchyOutput>("span_hierarchy", params),
  list_logs: (params?: Record<string, unknown>) =>
    queryTinybird<ListLogsOutput>("list_logs", params),
  logs_count: (params?: Record<string, unknown>) =>
    queryTinybird<LogsCountOutput>("logs_count", params),
  logs_facets: (params?: Record<string, unknown>) =>
    queryTinybird<LogsFacetsOutput>("logs_facets", params),
  error_rate_by_service: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorRateByServiceOutput>("error_rate_by_service", params),
  get_service_usage: (params?: Record<string, unknown>) =>
    queryTinybird<GetServiceUsageOutput>("get_service_usage", params),
  list_metrics: (params?: Record<string, unknown>) =>
    queryTinybird<ListMetricsOutput>("list_metrics", params),
  metric_time_series_sum: (params?: Record<string, unknown>) =>
    queryTinybird<MetricTimeSeriesSumOutput>("metric_time_series_sum", params),
  metric_time_series_gauge: (params?: Record<string, unknown>) =>
    queryTinybird<MetricTimeSeriesGaugeOutput>("metric_time_series_gauge", params),
  metric_time_series_histogram: (params?: Record<string, unknown>) =>
    queryTinybird<MetricTimeSeriesHistogramOutput>("metric_time_series_histogram", params),
  metric_time_series_exp_histogram: (params?: Record<string, unknown>) =>
    queryTinybird<MetricTimeSeriesExpHistogramOutput>("metric_time_series_exp_histogram", params),
  metrics_summary: (params?: Record<string, unknown>) =>
    queryTinybird<MetricsSummaryOutput>("metrics_summary", params),
  traces_facets: (params?: Record<string, unknown>) =>
    queryTinybird<TracesFacetsOutput>("traces_facets", params),
  traces_duration_stats: (params?: Record<string, unknown>) =>
    queryTinybird<TracesDurationStatsOutput>("traces_duration_stats", params),
  service_overview: (params?: Record<string, unknown>) =>
    queryTinybird<ServiceOverviewOutput>("service_overview", params),
  services_facets: (params?: Record<string, unknown>) =>
    queryTinybird<ServicesFacetsOutput>("services_facets", params),
  errors_by_type: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorsByTypeOutput>("errors_by_type", params),
  error_detail_traces: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorDetailTracesOutput>("error_detail_traces", params),
  errors_facets: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorsFacetsOutput>("errors_facets", params),
  errors_summary: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorsSummaryOutput>("errors_summary", params),
  service_apdex_time_series: (params?: Record<string, unknown>) =>
    queryTinybird<ServiceApdexTimeSeriesOutput>("service_apdex_time_series", params),
  custom_traces_timeseries: (params?: Record<string, unknown>) =>
    queryTinybird<CustomTracesTimeseriesOutput>("custom_traces_timeseries", params),
  custom_traces_breakdown: (params?: Record<string, unknown>) =>
    queryTinybird<CustomTracesBreakdownOutput>("custom_traces_breakdown", params),
  custom_logs_timeseries: (params?: Record<string, unknown>) =>
    queryTinybird<CustomLogsTimeseriesOutput>("custom_logs_timeseries", params),
  custom_logs_breakdown: (params?: Record<string, unknown>) =>
    queryTinybird<CustomLogsBreakdownOutput>("custom_logs_breakdown", params),
  custom_metrics_breakdown: (params?: Record<string, unknown>) =>
    queryTinybird<CustomMetricsBreakdownOutput>("custom_metrics_breakdown", params),
  service_dependencies: (params?: Record<string, unknown>) =>
    queryTinybird<ServiceDependenciesOutput>("service_dependencies", params),
  span_attribute_keys: (params?: Record<string, unknown>) =>
    queryTinybird<SpanAttributeKeysOutput>("span_attribute_keys", params),
  span_attribute_values: (params?: Record<string, unknown>) =>
    queryTinybird<SpanAttributeValuesOutput>("span_attribute_values", params),
}

export function createTinybird() {
  return {
    query,
  }
}

let _tinybird: ReturnType<typeof createTinybird> | null = null

export function getTinybird() {
  if (!_tinybird) {
    _tinybird = createTinybird()
  }
  return _tinybird
}
