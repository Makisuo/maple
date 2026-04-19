// ---------------------------------------------------------------------------
// Tinybird Endpoint Types
//
// Type-only definitions for query results. The actual SQL queries are compiled
// by @maple/query-engine — these types exist solely for consumers that import
// output/param shapes (apps/web, observability layer).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// list_traces
// ---------------------------------------------------------------------------

export interface ListTracesOutput {
  readonly traceId: string
  readonly startTime: string
  readonly endTime: string
  readonly durationMicros: number
  readonly spanCount: number
  readonly services: string[]
  readonly rootSpanName: string
  readonly rootSpanKind: string
  readonly rootSpanStatusCode: string
  readonly rootHttpMethod: string
  readonly rootHttpRoute: string
  readonly rootHttpStatusCode: string
  readonly hasError: number
}

export interface ListTracesParams {
  org_id: string
  limit?: number
  offset?: number
  service?: string
  start_time?: string
  end_time?: string
  span_name?: string
  has_error?: boolean
  min_duration_ms?: number
  max_duration_ms?: number
  http_method?: string
  http_status_code?: string
  deployment_env?: string
  service_match_mode?: string
  span_name_match_mode?: string
  deployment_env_match_mode?: string
  attribute_filter_key?: string
  attribute_filter_value?: string
  attribute_filter_value_match_mode?: string
  resource_filter_key?: string
  resource_filter_value?: string
  resource_filter_value_match_mode?: string
  any_service?: string
  any_span_name?: string
  any_span_name_match_mode?: string
}

// ---------------------------------------------------------------------------
// span_hierarchy
// ---------------------------------------------------------------------------

export interface SpanHierarchyOutput {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly spanKind: string
  readonly durationMs: number
  readonly startTime: string
  readonly statusCode: string
  readonly statusMessage: string
  readonly spanAttributes: string
  readonly resourceAttributes: string
  readonly relationship: string
}

export interface SpanHierarchyParams {
  org_id: string
  trace_id: string
  span_id?: string
}

// ---------------------------------------------------------------------------
// list_logs
// ---------------------------------------------------------------------------

export interface ListLogsOutput {
  readonly timestamp: string
  readonly severityText: string
  readonly severityNumber: number
  readonly serviceName: string
  readonly body: string
  readonly traceId: string
  readonly spanId: string
  readonly logAttributes: string
  readonly resourceAttributes: string
}

export interface ListLogsParams {
  org_id: string
  limit?: number
  service?: string
  severity?: string
  min_severity?: number
  start_time?: string
  end_time?: string
  trace_id?: string
  span_id?: string
  cursor?: string
  search?: string
}

// ---------------------------------------------------------------------------
// logs_count
// ---------------------------------------------------------------------------

export interface LogsCountOutput {
  readonly total: number
}

export interface LogsCountParams {
  org_id: string
  service?: string
  severity?: string
  start_time?: string
  end_time?: string
  trace_id?: string
  search?: string
}

// ---------------------------------------------------------------------------
// logs_facets
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
  readonly severityText: string
  readonly serviceName: string
  readonly count: number
  readonly facetType: string
}

export interface LogsFacetsParams {
  org_id: string
  service?: string
  severity?: string
  start_time?: string
  end_time?: string
}

// ---------------------------------------------------------------------------
// error_rate_by_service
// ---------------------------------------------------------------------------

export interface ErrorRateByServiceOutput {
  readonly serviceName: string
  readonly totalLogs: number
  readonly errorLogs: number
  readonly errorRate: number
}

export interface ErrorRateByServiceParams {
  org_id: string
  start_time?: string
  end_time?: string
}

// ---------------------------------------------------------------------------
// get_service_usage
// ---------------------------------------------------------------------------

export interface GetServiceUsageOutput {
  readonly serviceName: string
  readonly totalLogCount: number
  readonly totalLogSizeBytes: number
  readonly totalTraceCount: number
  readonly totalTraceSizeBytes: number
  readonly totalSumMetricCount: number
  readonly totalSumMetricSizeBytes: number
  readonly totalGaugeMetricCount: number
  readonly totalGaugeMetricSizeBytes: number
  readonly totalHistogramMetricCount: number
  readonly totalHistogramMetricSizeBytes: number
  readonly totalExpHistogramMetricCount: number
  readonly totalExpHistogramMetricSizeBytes: number
  readonly totalSizeBytes: number
}

export interface GetServiceUsageParams {
  org_id: string
  service?: string
  start_time?: string
  end_time?: string
}

// ---------------------------------------------------------------------------
// get_service_usage_compare
// ---------------------------------------------------------------------------

export type GetServiceUsageComparedOutput = GetServiceUsageOutput & {
  readonly period: "current" | "previous"
}

export interface GetServiceUsageCompareParams {
  org_id: string
  service?: string
  current_start_time: string
  current_end_time: string
  previous_start_time: string
  previous_end_time: string
}

// ---------------------------------------------------------------------------
// list_metrics
// ---------------------------------------------------------------------------

export interface ListMetricsOutput {
  readonly metricName: string
  readonly metricType: string
  readonly serviceName: string
  readonly metricDescription: string
  readonly metricUnit: string
  readonly dataPointCount: number
  readonly firstSeen: string
  readonly lastSeen: string
  readonly isMonotonic: boolean | number
}

export interface ListMetricsParams {
  org_id: string
  limit?: number
  offset?: number
  service?: string
  metric_type?: string
  start_time?: string
  end_time?: string
  search?: string
}

// ---------------------------------------------------------------------------
// metrics_summary
// ---------------------------------------------------------------------------

export interface MetricsSummaryOutput {
  readonly metricType: string
  readonly metricCount: number
  readonly dataPointCount: number
}

export interface MetricsSummaryParams {
  org_id: string
  service?: string
  start_time?: string
  end_time?: string
}

// ---------------------------------------------------------------------------
// traces_facets
// ---------------------------------------------------------------------------

export interface TracesFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export interface TracesFacetsParams {
  org_id: string
  start_time?: string
  end_time?: string
  service?: string
  span_name?: string
  has_error?: boolean
  min_duration_ms?: number
  max_duration_ms?: number
  http_method?: string
  http_status_code?: string
  deployment_env?: string
  service_match_mode?: string
  span_name_match_mode?: string
  deployment_env_match_mode?: string
  attribute_filter_key?: string
  attribute_filter_value?: string
  attribute_filter_value_match_mode?: string
  resource_filter_key?: string
  resource_filter_value?: string
  resource_filter_value_match_mode?: string
}

// ---------------------------------------------------------------------------
// traces_duration_stats
// ---------------------------------------------------------------------------

export interface TracesDurationStatsOutput {
  readonly minDurationMs: number
  readonly maxDurationMs: number
  readonly p50DurationMs: number
  readonly p95DurationMs: number
}

export interface TracesDurationStatsParams {
  org_id: string
  start_time?: string
  end_time?: string
  service?: string
  span_name?: string
  has_error?: boolean
  http_method?: string
  http_status_code?: string
  deployment_env?: string
  service_match_mode?: string
  span_name_match_mode?: string
  deployment_env_match_mode?: string
  attribute_filter_key?: string
  attribute_filter_value?: string
  attribute_filter_value_match_mode?: string
  resource_filter_key?: string
  resource_filter_value?: string
  resource_filter_value_match_mode?: string
}

// ---------------------------------------------------------------------------
// service_overview
// ---------------------------------------------------------------------------

export interface ServiceOverviewOutput {
  readonly serviceName: string
  readonly environment: string
  readonly commitSha: string
  readonly throughput: number
  readonly errorCount: number
  readonly spanCount: number
  readonly p50LatencyMs: number
  readonly p95LatencyMs: number
  readonly p99LatencyMs: number
  readonly sampledSpanCount: number
  readonly unsampledSpanCount: number
  readonly dominantThreshold: string
}

export interface ServiceOverviewParams {
  org_id: string
  start_time?: string
  end_time?: string
  environments?: string
  commit_shas?: string
}

// ---------------------------------------------------------------------------
// service_overview_compare
// ---------------------------------------------------------------------------

export type ServiceOverviewComparedOutput = ServiceOverviewOutput & {
  readonly period: "current" | "previous"
}

export interface ServiceOverviewCompareParams {
  org_id: string
  current_start_time: string
  current_end_time: string
  previous_start_time: string
  previous_end_time: string
  environments?: string
  commit_shas?: string
}

// ---------------------------------------------------------------------------
// services_facets
// ---------------------------------------------------------------------------

export interface ServicesFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export interface ServicesFacetsParams {
  org_id: string
  start_time?: string
  end_time?: string
}

// ---------------------------------------------------------------------------
// service_releases_timeline
// ---------------------------------------------------------------------------

export interface ServiceReleasesTimelineOutput {
  readonly bucket: string
  readonly commitSha: string
  readonly count: number
}

export interface ServiceReleasesTimelineParams {
  org_id: string
  service_name: string
  start_time?: string
  end_time?: string
  bucket_seconds?: number
}

// ---------------------------------------------------------------------------
// errors_by_type
// ---------------------------------------------------------------------------

export interface ErrorsByTypeOutput {
  readonly errorType: string
  readonly sampleMessage: string
  readonly count: number
  readonly affectedServicesCount: number
  readonly firstSeen: string
  readonly lastSeen: string
}

export interface ErrorsByTypeParams {
  org_id: string
  start_time?: string
  end_time?: string
  services?: string
  deployment_envs?: string
  error_types?: string
  limit?: number
  exclude_spam_patterns?: string
  root_only?: boolean
}

// ---------------------------------------------------------------------------
// errors_timeseries
// ---------------------------------------------------------------------------

export interface ErrorsTimeseriesOutput {
  readonly bucket: string
  readonly count: number
}

export interface ErrorsTimeseriesParams {
  org_id: string
  error_type: string
  start_time?: string
  end_time?: string
  bucket_seconds?: number
  services?: string
  exclude_spam_patterns?: string
}

// ---------------------------------------------------------------------------
// error_detail_traces
// ---------------------------------------------------------------------------

export interface ErrorDetailTracesOutput {
  readonly traceId: string
  readonly startTime: string
  readonly durationMicros: number
  readonly spanCount: number
  readonly services: string[]
  readonly rootSpanName: string
  readonly errorMessage: string
}

export interface ErrorDetailTracesParams {
  org_id: string
  error_type: string
  start_time?: string
  end_time?: string
  services?: string
  limit?: number
  exclude_spam_patterns?: string
  root_only?: boolean
}

// ---------------------------------------------------------------------------
// errors_facets
// ---------------------------------------------------------------------------

export interface ErrorsFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export interface ErrorsFacetsParams {
  org_id: string
  start_time?: string
  end_time?: string
  services?: string
  deployment_envs?: string
  error_types?: string
  exclude_spam_patterns?: string
  root_only?: boolean
}

// ---------------------------------------------------------------------------
// errors_summary
// ---------------------------------------------------------------------------

export interface ErrorsSummaryOutput {
  readonly totalErrors: number
  readonly totalSpans: number
  readonly errorRate: number
  readonly affectedServicesCount: number
  readonly affectedTracesCount: number
}

export interface ErrorsSummaryParams {
  org_id: string
  start_time?: string
  end_time?: string
  services?: string
  deployment_envs?: string
  error_types?: string
  exclude_spam_patterns?: string
  root_only?: boolean
}

// ---------------------------------------------------------------------------
// service_apdex_time_series
// ---------------------------------------------------------------------------

export interface ServiceApdexTimeSeriesOutput {
  readonly bucket: string
  readonly totalCount: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
}

export interface ServiceApdexTimeSeriesParams {
  org_id: string
  service_name: string
  start_time?: string
  end_time?: string
  bucket_seconds?: number
  apdex_threshold_ms?: number
}

// ---------------------------------------------------------------------------
// Alert aggregates
// ---------------------------------------------------------------------------

export interface AlertTracesAggregateOutput {
  readonly count: number
  readonly avgDuration: number
  readonly p50Duration: number
  readonly p95Duration: number
  readonly p99Duration: number
  readonly errorRate: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
}

export interface AlertTracesAggregateParams {
  org_id: string
  start_time: string
  end_time: string
  service_name?: string
  span_name?: string
  root_only?: boolean
  environments?: string
  commit_shas?: string
  errors_only?: boolean
  apdex_threshold_ms?: number
  [key: string]: unknown
}

export interface AlertMetricsAggregateOutput {
  readonly avgValue: number
  readonly minValue: number
  readonly maxValue: number
  readonly sumValue: number
  readonly dataPointCount: number
}

export interface AlertMetricsAggregateParams {
  org_id: string
  metric_name: string
  metric_type: string
  service?: string
  start_time: string
  end_time: string
}

export interface AlertLogsAggregateOutput {
  readonly count: number
}

export interface AlertLogsAggregateParams {
  org_id: string
  start_time: string
  end_time: string
  service_name?: string
  severity?: string
}

export interface AlertTracesAggregateByServiceOutput extends AlertTracesAggregateOutput {
  readonly serviceName: string
}

export interface AlertTracesAggregateByServiceParams {
  org_id: string
  start_time: string
  end_time: string
  span_name?: string
  root_only?: boolean
  environments?: string
  commit_shas?: string
  errors_only?: boolean
  apdex_threshold_ms?: number
  [key: string]: unknown
}

export interface AlertMetricsAggregateByServiceOutput extends AlertMetricsAggregateOutput {
  readonly serviceName: string
}

export interface AlertMetricsAggregateByServiceParams {
  org_id: string
  metric_name: string
  metric_type: string
  start_time: string
  end_time: string
}

export interface AlertLogsAggregateByServiceOutput extends AlertLogsAggregateOutput {
  readonly serviceName: string
}

export interface AlertLogsAggregateByServiceParams {
  org_id: string
  start_time: string
  end_time: string
  severity?: string
}

// ---------------------------------------------------------------------------
// Custom charts
// ---------------------------------------------------------------------------

export interface CustomTracesTimeseriesOutput {
  readonly bucket: string
  readonly groupName: string
  readonly count: number
  readonly avgDuration: number
  readonly p50Duration: number
  readonly p95Duration: number
  readonly p99Duration: number
  readonly errorRate: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
  readonly sampledSpanCount: number
  readonly unsampledSpanCount: number
  readonly dominantThreshold: string
}

export interface CustomTracesTimeseriesParams {
  org_id: string
  start_time: string
  end_time: string
  bucket_seconds?: number
  service_name?: string
  span_name?: string
  group_by_service?: string
  group_by_span_name?: string
  group_by_status_code?: string
  group_by_http_method?: string
  group_by_attributes?: string
  root_only?: boolean
  environments?: string
  commit_shas?: string
  errors_only?: boolean
  apdex_threshold_ms?: number
  [key: string]: unknown
}

export interface CustomTracesBreakdownOutput {
  readonly name: string
  readonly count: number
  readonly avgDuration: number
  readonly p50Duration: number
  readonly p95Duration: number
  readonly p99Duration: number
  readonly errorRate: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
}

export interface CustomTracesBreakdownParams {
  org_id: string
  start_time: string
  end_time: string
  service_name?: string
  span_name?: string
  limit?: number
  group_by_service?: string
  group_by_span_name?: string
  group_by_status_code?: string
  group_by_http_method?: string
  group_by_attribute?: string
  root_only?: boolean
  environments?: string
  commit_shas?: string
  errors_only?: boolean
  apdex_threshold_ms?: number
  [key: string]: unknown
}

export interface CustomLogsTimeseriesOutput {
  readonly bucket: string
  readonly groupName: string
  readonly count: number
}

export interface CustomLogsTimeseriesParams {
  org_id: string
  start_time: string
  end_time: string
  bucket_seconds?: number
  service_name?: string
  severity?: string
  group_by_service?: string
  group_by_severity?: string
}

export interface CustomLogsBreakdownOutput {
  readonly name: string
  readonly count: number
}

export interface CustomLogsBreakdownParams {
  org_id: string
  start_time: string
  end_time: string
  service_name?: string
  severity?: string
  limit?: number
  group_by_service?: string
  group_by_severity?: string
}

// ---------------------------------------------------------------------------
// service_dependencies
// ---------------------------------------------------------------------------

export interface ServiceDependenciesOutput {
  readonly sourceService: string
  readonly targetService: string
  readonly callCount: number
  readonly errorCount: number
  readonly avgDurationMs: number
  readonly p95DurationMs: number
  readonly sampledSpanCount: number
  readonly unsampledSpanCount: number
  readonly dominantThreshold: string
}

export interface ServiceDependenciesParams {
  org_id: string
  start_time?: string
  end_time?: string
  deployment_env?: string
}

// ---------------------------------------------------------------------------
// Attribute keys & values
// ---------------------------------------------------------------------------

export interface SpanAttributeKeysOutput {
  readonly attributeKey: string
  readonly usageCount: number
}

export interface SpanAttributeKeysParams {
  org_id: string
  start_time: string
  end_time: string
  limit?: number
}

export interface MetricAttributeKeysOutput {
  readonly attributeKey: string
  readonly usageCount: number
}

export interface MetricAttributeKeysParams {
  org_id: string
  start_time: string
  end_time: string
  metric_name?: string
  metric_type?: string
  limit?: number
}

export interface SpanAttributeValuesOutput {
  readonly attributeValue: string
  readonly usageCount: number
}

export interface SpanAttributeValuesParams {
  org_id: string
  start_time: string
  end_time: string
  attribute_key: string
  limit?: number
}

export interface ResourceAttributeKeysOutput {
  readonly attributeKey: string
  readonly usageCount: number
}

export interface ResourceAttributeKeysParams {
  org_id: string
  start_time: string
  end_time: string
  limit?: number
}

export interface ResourceAttributeValuesOutput {
  readonly attributeValue: string
  readonly usageCount: number
}

export interface ResourceAttributeValuesParams {
  org_id: string
  start_time: string
  end_time: string
  attribute_key: string
  limit?: number
}
