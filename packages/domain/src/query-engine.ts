import { Schema } from "effect"

const dateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export const TinybirdDateTime = Schema.String.pipe(
  Schema.check(Schema.isPattern(dateTimePattern)),
  Schema.annotate({
    identifier: "TinybirdDateTime",
    description: "Date time string in YYYY-MM-DD HH:mm:ss format",
  }),
)

export const TracesMetric = Schema.Literals([
  "count",
  "avg_duration",
  "p50_duration",
  "p95_duration",
  "p99_duration",
  "error_rate",
])
export type TracesMetric = Schema.Schema.Type<typeof TracesMetric>

export const MetricsMetric = Schema.Literals(["avg", "sum", "min", "max", "count"])
export type MetricsMetric = Schema.Schema.Type<typeof MetricsMetric>

export const MetricType = Schema.Literals([
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
])
export type MetricType = Schema.Schema.Type<typeof MetricType>

export const TracesFilters = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  spanName: Schema.optional(Schema.String),
  rootSpansOnly: Schema.optional(Schema.Boolean),
  environments: Schema.optional(Schema.Array(Schema.String)),
  commitShas: Schema.optional(Schema.Array(Schema.String)),
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
  attributeFilterMode: Schema.optional(Schema.Literals(["equals", "exists"])),
  groupByAttributeKeys: Schema.optional(Schema.Array(Schema.String)),
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
  resourceAttributeFilterMode: Schema.optional(Schema.Literals(["equals", "exists"])),
  errorsOnly: Schema.optional(Schema.Boolean),
})
export type TracesFilters = Schema.Schema.Type<typeof TracesFilters>

export const LogsFilters = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
})
export type LogsFilters = Schema.Schema.Type<typeof LogsFilters>

export const MetricsFilters = Schema.Struct({
  metricName: Schema.String,
  metricType: MetricType,
  serviceName: Schema.optional(Schema.String),
})
export type MetricsFilters = Schema.Schema.Type<typeof MetricsFilters>

export const TracesTimeseriesQuery = Schema.Struct({
  kind: Schema.Literal("timeseries"),
  source: Schema.Literal("traces"),
  metric: TracesMetric,
  groupBy: Schema.optional(
    Schema.Array(Schema.Literals([
      "service",
      "span_name",
      "status_code",
      "http_method",
      "attribute",
      "none",
    ])),
  ),
  filters: Schema.optional(TracesFilters),
  bucketSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
})
export type TracesTimeseriesQuery = Schema.Schema.Type<typeof TracesTimeseriesQuery>

export const LogsTimeseriesQuery = Schema.Struct({
  kind: Schema.Literal("timeseries"),
  source: Schema.Literal("logs"),
  metric: Schema.Literal("count"),
  groupBy: Schema.optional(Schema.Array(Schema.Literals(["service", "severity", "none"]))),
  filters: Schema.optional(LogsFilters),
  bucketSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
})
export type LogsTimeseriesQuery = Schema.Schema.Type<typeof LogsTimeseriesQuery>

export const MetricsTimeseriesQuery = Schema.Struct({
  kind: Schema.Literal("timeseries"),
  source: Schema.Literal("metrics"),
  metric: MetricsMetric,
  groupBy: Schema.optional(Schema.Array(Schema.Literals(["service", "none"]))),
  filters: MetricsFilters,
  bucketSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
})
export type MetricsTimeseriesQuery = Schema.Schema.Type<typeof MetricsTimeseriesQuery>

export const TracesBreakdownQuery = Schema.Struct({
  kind: Schema.Literal("breakdown"),
  source: Schema.Literal("traces"),
  metric: TracesMetric,
  groupBy: Schema.Literals([
    "service",
    "span_name",
    "status_code",
    "http_method",
    "attribute",
  ]),
  filters: Schema.optional(TracesFilters),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
})
export type TracesBreakdownQuery = Schema.Schema.Type<typeof TracesBreakdownQuery>

export const LogsBreakdownQuery = Schema.Struct({
  kind: Schema.Literal("breakdown"),
  source: Schema.Literal("logs"),
  metric: Schema.Literal("count"),
  groupBy: Schema.Literals(["service", "severity"]),
  filters: Schema.optional(LogsFilters),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
})
export type LogsBreakdownQuery = Schema.Schema.Type<typeof LogsBreakdownQuery>

export const MetricsBreakdownQuery = Schema.Struct({
  kind: Schema.Literal("breakdown"),
  source: Schema.Literal("metrics"),
  metric: Schema.Literals(["avg", "sum", "count"]),
  groupBy: Schema.Literal("service"),
  filters: MetricsFilters,
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
})
export type MetricsBreakdownQuery = Schema.Schema.Type<typeof MetricsBreakdownQuery>

export const QuerySpec = Schema.Union([
  TracesTimeseriesQuery,
  LogsTimeseriesQuery,
  MetricsTimeseriesQuery,
  TracesBreakdownQuery,
  LogsBreakdownQuery,
  MetricsBreakdownQuery,
])
export type QuerySpec = Schema.Schema.Type<typeof QuerySpec>

export class QueryEngineExecuteRequest extends Schema.Class<QueryEngineExecuteRequest>(
  "QueryEngineExecuteRequest",
)({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  query: QuerySpec,
}) {}

export const TimeseriesPoint = Schema.Struct({
  bucket: Schema.String,
  series: Schema.Record(Schema.String, Schema.Number),
})
export type TimeseriesPoint = Schema.Schema.Type<typeof TimeseriesPoint>

export const BreakdownItem = Schema.Struct({
  name: Schema.String,
  value: Schema.Number,
})
export type BreakdownItem = Schema.Schema.Type<typeof BreakdownItem>

export const QueryEngineResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("timeseries"),
    source: Schema.Literals(["traces", "logs", "metrics"]),
    data: Schema.Array(TimeseriesPoint),
  }),
  Schema.Struct({
    kind: Schema.Literal("breakdown"),
    source: Schema.Literals(["traces", "logs", "metrics"]),
    data: Schema.Array(BreakdownItem),
  }),
])
export type QueryEngineResult = Schema.Schema.Type<typeof QueryEngineResult>

export class QueryEngineExecuteResponse extends Schema.Class<QueryEngineExecuteResponse>(
  "QueryEngineExecuteResponse",
)({
  result: QueryEngineResult,
}) {}
