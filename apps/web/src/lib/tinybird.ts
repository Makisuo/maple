import { TinybirdQueryRequest, type TinybirdPipe } from "@maple/domain"
import { Effect } from "effect"
import { MapleApiAtomClient } from "./services/common/atom-client"
import { setMapleAuthHeaders } from "./services/common/auth-headers"

import type {
  CustomLogsBreakdownOutput,
  CustomLogsTimeseriesOutput,
  CustomTracesBreakdownOutput,
  CustomTracesTimeseriesOutput,
  ErrorDetailTracesOutput,
  ErrorRateByServiceOutput,
  ErrorsByTypeOutput,
  ErrorsFacetsOutput,
  ErrorsSummaryOutput,
  ErrorsTimeseriesOutput,
  GetServiceUsageOutput,
  ListLogsOutput,
  ListMetricsOutput,
  ListTracesOutput,
  LogsCountOutput,
  LogsFacetsOutput,
  MetricsSummaryOutput,
  ServiceApdexTimeSeriesOutput,
  ServiceDependenciesOutput,
  ServiceOverviewOutput,
  ServicesFacetsOutput,
  MetricAttributeKeysOutput,
  ResourceAttributeKeysOutput,
  ResourceAttributeValuesOutput,
  SpanAttributeKeysOutput,
  SpanAttributeValuesOutput,
  SpanHierarchyOutput,
  TracesDurationStatsOutput,
  TracesFacetsOutput,
} from "@maple/domain/tinybird"

export type {
  CustomLogsBreakdownParams,
  CustomLogsBreakdownOutput,
  CustomLogsTimeseriesParams,
  CustomLogsTimeseriesOutput,
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
  ErrorsTimeseriesParams,
  ErrorsTimeseriesOutput,
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
  ResourceAttributeKeysParams,
  ResourceAttributeKeysOutput,
  ResourceAttributeValuesParams,
  ResourceAttributeValuesOutput,
  MetricAttributeKeysParams,
  MetricAttributeKeysOutput,
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
} from "@maple/domain/tinybird"

type QueryResponse<T> = {
  data: T[]
}

export { setMapleAuthHeaders }

const queryTinybirdEffect = <T>(
  pipe: TinybirdPipe,
  params?: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const client = yield* MapleApiAtomClient
    return (yield* client.tinybird.query({
      payload: new TinybirdQueryRequest({
        pipe,
        params,
      }),
    })) as QueryResponse<T>
  })

const queryTinybird = <T>(pipe: TinybirdPipe, params?: Record<string, unknown>) =>
  queryTinybirdEffect<T>(pipe, params)

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
  errors_timeseries: (params?: Record<string, unknown>) =>
    queryTinybird<ErrorsTimeseriesOutput>("errors_timeseries", params),
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
  service_dependencies: (params?: Record<string, unknown>) =>
    queryTinybird<ServiceDependenciesOutput>("service_dependencies", params),
  metric_attribute_keys: (params?: Record<string, unknown>) =>
    queryTinybird<MetricAttributeKeysOutput>("metric_attribute_keys", params),
  span_attribute_keys: (params?: Record<string, unknown>) =>
    queryTinybird<SpanAttributeKeysOutput>("span_attribute_keys", params),
  span_attribute_values: (params?: Record<string, unknown>) =>
    queryTinybird<SpanAttributeValuesOutput>("span_attribute_values", params),
  resource_attribute_keys: (params?: Record<string, unknown>) =>
    queryTinybird<ResourceAttributeKeysOutput>("resource_attribute_keys", params),
  resource_attribute_values: (params?: Record<string, unknown>) =>
    queryTinybird<ResourceAttributeValuesOutput>("resource_attribute_values", params),
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
