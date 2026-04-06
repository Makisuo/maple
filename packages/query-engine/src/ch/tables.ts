// ---------------------------------------------------------------------------
// Maple Table Definitions
//
// Derived from packages/domain/src/tinybird/datasources.ts
// These define the ClickHouse table schemas used by the query DSL.
// ---------------------------------------------------------------------------

import * as T from "./types"
import { table } from "./table"

export const Traces = table("traces", {
  OrgId: T.string,
  Timestamp: T.dateTime64,
  TraceId: T.string,
  SpanId: T.string,
  ParentSpanId: T.string,
  TraceState: T.string,
  SpanName: T.string,
  SpanKind: T.string,
  ServiceName: T.string,
  ResourceSchemaUrl: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ScopeSchemaUrl: T.string,
  ScopeName: T.string,
  ScopeVersion: T.string,
  ScopeAttributes: T.map(T.string, T.string),
  Duration: T.uint64,
  StatusCode: T.string,
  StatusMessage: T.string,
  SpanAttributes: T.map(T.string, T.string),
  EventsTimestamp: T.array(T.dateTime64),
  EventsName: T.array(T.string),
  EventsAttributes: T.array(T.map(T.string, T.string)),
  LinksTraceId: T.array(T.string),
  LinksSpanId: T.array(T.string),
  LinksTraceState: T.array(T.string),
  LinksAttributes: T.array(T.map(T.string, T.string)),
})

export const TraceListMv = table("trace_list_mv", {
  OrgId: T.string,
  TraceId: T.string,
  Timestamp: T.dateTime,
  ServiceName: T.string,
  SpanName: T.string,
  SpanKind: T.string,
  Duration: T.uint64,
  StatusCode: T.string,
  HttpMethod: T.string,
  HttpRoute: T.string,
  HttpStatusCode: T.string,
  DeploymentEnv: T.string,
  HasError: T.uint8,
  TraceState: T.string,
})

export const Logs = table("logs", {
  OrgId: T.string,
  Timestamp: T.dateTime64,
  TimestampTime: T.dateTime,
  TraceId: T.string,
  SpanId: T.string,
  TraceFlags: T.uint8,
  SeverityText: T.string,
  SeverityNumber: T.uint8,
  ServiceName: T.string,
  Body: T.string,
  ResourceSchemaUrl: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ScopeSchemaUrl: T.string,
  ScopeName: T.string,
  ScopeVersion: T.string,
  ScopeAttributes: T.map(T.string, T.string),
  LogAttributes: T.map(T.string, T.string),
})

export const ServiceOverviewSpans = table("service_overview_spans", {
  OrgId: T.string,
  Timestamp: T.dateTime,
  ServiceName: T.string,
  Duration: T.uint64,
  StatusCode: T.string,
  TraceState: T.string,
  DeploymentEnv: T.string,
  CommitSha: T.string,
})

export const ErrorSpans = table("error_spans", {
  OrgId: T.string,
  Timestamp: T.dateTime,
  TraceId: T.string,
  SpanId: T.string,
  ParentSpanId: T.string,
  ServiceName: T.string,
  StatusMessage: T.string,
  Duration: T.uint64,
  DeploymentEnv: T.string,
})

export const MetricsSum = table("metrics_sum", {
  OrgId: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ServiceName: T.string,
  MetricName: T.string,
  MetricDescription: T.string,
  MetricUnit: T.string,
  Attributes: T.map(T.string, T.string),
  StartTimeUnix: T.dateTime64,
  TimeUnix: T.dateTime64,
  Value: T.float64,
  Flags: T.uint32,
  AggregationTemporality: T.int32,
  IsMonotonic: T.bool,
})

export const MetricsGauge = table("metrics_gauge", {
  OrgId: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ServiceName: T.string,
  MetricName: T.string,
  MetricDescription: T.string,
  MetricUnit: T.string,
  Attributes: T.map(T.string, T.string),
  StartTimeUnix: T.dateTime64,
  TimeUnix: T.dateTime64,
  Value: T.float64,
  Flags: T.uint32,
})

export const MetricsHistogram = table("metrics_histogram", {
  OrgId: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ServiceName: T.string,
  MetricName: T.string,
  MetricDescription: T.string,
  MetricUnit: T.string,
  Attributes: T.map(T.string, T.string),
  StartTimeUnix: T.dateTime64,
  TimeUnix: T.dateTime64,
  Count: T.uint64,
  Sum: T.float64,
  BucketCounts: T.array(T.uint64),
  ExplicitBounds: T.array(T.float64),
  Flags: T.uint32,
  Min: T.nullable(T.float64),
  Max: T.nullable(T.float64),
  AggregationTemporality: T.int32,
})

export const AttributeKeysHourly = table("attribute_keys_hourly", {
  OrgId: T.string,
  Hour: T.dateTime,
  AttributeKey: T.string,
  AttributeScope: T.string,
  UsageCount: T.uint64,
})

export const ServiceUsage = table("service_usage", {
  OrgId: T.string,
  ServiceName: T.string,
  Hour: T.dateTime,
  LogCount: T.uint64,
  LogSizeBytes: T.uint64,
  TraceCount: T.uint64,
  TraceSizeBytes: T.uint64,
  SumMetricCount: T.uint64,
  SumMetricSizeBytes: T.uint64,
  GaugeMetricCount: T.uint64,
  GaugeMetricSizeBytes: T.uint64,
  HistogramMetricCount: T.uint64,
  HistogramMetricSizeBytes: T.uint64,
  ExpHistogramMetricCount: T.uint64,
  ExpHistogramMetricSizeBytes: T.uint64,
})

export const ServiceMapSpans = table("service_map_spans", {
  OrgId: T.string,
  Timestamp: T.dateTime,
  TraceId: T.string,
  SpanId: T.string,
  ParentSpanId: T.string,
  ServiceName: T.string,
  SpanKind: T.string,
  Duration: T.uint64,
  StatusCode: T.string,
  TraceState: T.string,
  PeerService: T.string,
  DeploymentEnv: T.string,
})

export const ServiceMapChildren = table("service_map_children", {
  OrgId: T.string,
  Timestamp: T.dateTime,
  TraceId: T.string,
  ParentSpanId: T.string,
  ServiceName: T.string,
  SpanKind: T.string,
  Duration: T.uint64,
  StatusCode: T.string,
  TraceState: T.string,
  DeploymentEnv: T.string,
})

export const ServiceMapEdgesHourly = table("service_map_edges_hourly", {
  OrgId: T.string,
  Hour: T.dateTime,
  SourceService: T.string,
  TargetService: T.string,
  DeploymentEnv: T.string,
  CallCount: T.uint64,
  ErrorCount: T.uint64,
  DurationSumMs: T.float64,
  MaxDurationMs: T.float64,
  SampledSpanCount: T.uint64,
  UnsampledSpanCount: T.uint64,
})

export const MetricsExpHistogram = table("metrics_exponential_histogram", {
  OrgId: T.string,
  ResourceAttributes: T.map(T.string, T.string),
  ServiceName: T.string,
  MetricName: T.string,
  MetricDescription: T.string,
  MetricUnit: T.string,
  Attributes: T.map(T.string, T.string),
  StartTimeUnix: T.dateTime64,
  TimeUnix: T.dateTime64,
  Count: T.uint64,
  Sum: T.float64,
  Scale: T.int32,
  ZeroCount: T.uint64,
  Flags: T.uint32,
  Min: T.nullable(T.float64),
  Max: T.nullable(T.float64),
  AggregationTemporality: T.int32,
})
