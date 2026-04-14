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
  "apdex",
])
export type TracesMetric = Schema.Schema.Type<typeof TracesMetric>

export const MetricsMetric = Schema.Literals(["avg", "sum", "min", "max", "count", "rate", "increase"])
export type MetricsMetric = Schema.Schema.Type<typeof MetricsMetric>

export const MetricType = Schema.Literals([
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
])
export type MetricType = Schema.Schema.Type<typeof MetricType>

export const AttributeFilter = Schema.Struct({
  key: Schema.String,
  value: Schema.optional(Schema.String),
  mode: Schema.Literals(["equals", "exists", "gt", "gte", "lt", "lte", "contains"]),
})
export type AttributeFilter = Schema.Schema.Type<typeof AttributeFilter>

export const TracesMatchModes = Schema.Struct({
  serviceName: Schema.optional(Schema.Literals(["contains"])),
  spanName: Schema.optional(Schema.Literals(["contains"])),
  deploymentEnv: Schema.optional(Schema.Literals(["contains"])),
})
export type TracesMatchModes = Schema.Schema.Type<typeof TracesMatchModes>

export const TracesFilters = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  spanName: Schema.optional(Schema.String),
  rootSpansOnly: Schema.optional(Schema.Boolean),
  environments: Schema.optional(Schema.Array(Schema.String)),
  commitShas: Schema.optional(Schema.Array(Schema.String)),
  groupByAttributeKeys: Schema.optional(Schema.Array(Schema.String)),
  errorsOnly: Schema.optional(Schema.Boolean),
  minDurationMs: Schema.optional(Schema.Number),
  maxDurationMs: Schema.optional(Schema.Number),
  matchModes: Schema.optional(TracesMatchModes),
  attributeFilters: Schema.optional(Schema.Array(AttributeFilter)),
  resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilter)),
})
export type TracesFilters = Schema.Schema.Type<typeof TracesFilters>

export const LogsFilters = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  traceId: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  environments: Schema.optional(Schema.Array(Schema.String)),
  deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
})
export type LogsFilters = Schema.Schema.Type<typeof LogsFilters>

export const ErrorsFilters = Schema.Struct({
  rootOnly: Schema.optional(Schema.Boolean),
  services: Schema.optional(Schema.Array(Schema.String)),
  deploymentEnvs: Schema.optional(Schema.Array(Schema.String)),
  errorTypes: Schema.optional(Schema.Array(Schema.String)),
})
export type ErrorsFilters = Schema.Schema.Type<typeof ErrorsFilters>

export const MetricsFilters = Schema.Struct({
  metricName: Schema.String,
  metricType: MetricType,
  serviceName: Schema.optional(Schema.String),
  groupByAttributeKey: Schema.optional(Schema.String),
  attributeFilters: Schema.optional(Schema.Array(AttributeFilter)),
})
export type MetricsFilters = Schema.Schema.Type<typeof MetricsFilters>

export const TracesTimeseriesQuery = Schema.Struct({
  kind: Schema.Literal("timeseries"),
  source: Schema.Literal("traces"),
  metric: TracesMetric,
  allMetrics: Schema.optional(Schema.Boolean),
  apdexThresholdMs: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  ),
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
  groupBy: Schema.optional(Schema.Array(Schema.Literals(["service", "attribute", "none"]))),
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
  apdexThresholdMs: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  ),
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

export const TracesListQuery = Schema.Struct({
  kind: Schema.Literal("list"),
  source: Schema.Literal("traces"),
  filters: Schema.optional(TracesFilters),
  columns: Schema.optional(Schema.Array(Schema.String)),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(200),
    ),
  ),
  offset: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  ),
})
export type TracesListQuery = Schema.Schema.Type<typeof TracesListQuery>

export const LogsListQuery = Schema.Struct({
  kind: Schema.Literal("list"),
  source: Schema.Literal("logs"),
  filters: Schema.optional(LogsFilters),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(200),
    ),
  ),
})
export type LogsListQuery = Schema.Schema.Type<typeof LogsListQuery>

export const AttributeKeysQuery = Schema.Struct({
  kind: Schema.Literal("attributeKeys"),
  source: Schema.Literals(["traces", "logs", "metrics"]),
  scope: Schema.optional(Schema.Literals(["span", "resource"])),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(500),
    ),
  ),
})
export type AttributeKeysQuery = Schema.Schema.Type<typeof AttributeKeysQuery>

export const TracesFacetsQuery = Schema.Struct({
  kind: Schema.Literal("facets"),
  source: Schema.Literal("traces"),
  filters: Schema.optional(TracesFilters),
})
export type TracesFacetsQuery = Schema.Schema.Type<typeof TracesFacetsQuery>

export const LogsFacetsQuery = Schema.Struct({
  kind: Schema.Literal("facets"),
  source: Schema.Literal("logs"),
  filters: Schema.optional(LogsFilters),
})
export type LogsFacetsQuery = Schema.Schema.Type<typeof LogsFacetsQuery>

export const ErrorsFacetsQuery = Schema.Struct({
  kind: Schema.Literal("facets"),
  source: Schema.Literal("errors"),
  filters: Schema.optional(ErrorsFilters),
})
export type ErrorsFacetsQuery = Schema.Schema.Type<typeof ErrorsFacetsQuery>

export const ServicesFacetsQuery = Schema.Struct({
  kind: Schema.Literal("facets"),
  source: Schema.Literal("services"),
})
export type ServicesFacetsQuery = Schema.Schema.Type<typeof ServicesFacetsQuery>

export const TracesStatsQuery = Schema.Struct({
  kind: Schema.Literal("stats"),
  source: Schema.Literal("traces"),
  filters: Schema.optional(TracesFilters),
})
export type TracesStatsQuery = Schema.Schema.Type<typeof TracesStatsQuery>

export const AttributeValuesQuery = Schema.Struct({
  kind: Schema.Literal("attributeValues"),
  source: Schema.Literal("traces"),
  scope: Schema.Literals(["span", "resource"]),
  attributeKey: Schema.String,
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(500),
    ),
  ),
})
export type AttributeValuesQuery = Schema.Schema.Type<typeof AttributeValuesQuery>

export const LogsCountQuery = Schema.Struct({
  kind: Schema.Literal("count"),
  source: Schema.Literal("logs"),
  filters: Schema.optional(LogsFilters),
})
export type LogsCountQuery = Schema.Schema.Type<typeof LogsCountQuery>

export const QuerySpec = Schema.Union([
  TracesTimeseriesQuery,
  LogsTimeseriesQuery,
  MetricsTimeseriesQuery,
  TracesBreakdownQuery,
  LogsBreakdownQuery,
  MetricsBreakdownQuery,
  TracesListQuery,
  LogsListQuery,
  AttributeKeysQuery,
  TracesFacetsQuery,
  LogsFacetsQuery,
  ErrorsFacetsQuery,
  ServicesFacetsQuery,
  TracesStatsQuery,
  AttributeValuesQuery,
  LogsCountQuery,
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

export const ListRow = Schema.Record(Schema.String, Schema.Unknown)
export type ListRow = Schema.Schema.Type<typeof ListRow>

export const AttributeKeyItem = Schema.Struct({
  key: Schema.String,
  count: Schema.Number,
})
export type AttributeKeyItem = Schema.Schema.Type<typeof AttributeKeyItem>

export const FacetItem = Schema.Struct({
  facetType: Schema.String,
  name: Schema.String,
  count: Schema.Number,
})
export type FacetItem = Schema.Schema.Type<typeof FacetItem>

export const DurationStats = Schema.Struct({
  minDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
  p50DurationMs: Schema.Number,
  p95DurationMs: Schema.Number,
})
export type DurationStats = Schema.Schema.Type<typeof DurationStats>

export const AttributeValueItem = Schema.Struct({
  value: Schema.String,
  count: Schema.Number,
})
export type AttributeValueItem = Schema.Schema.Type<typeof AttributeValueItem>

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
  Schema.Struct({
    kind: Schema.Literal("list"),
    source: Schema.Literals(["traces", "logs"]),
    data: Schema.Array(ListRow),
  }),
  Schema.Struct({
    kind: Schema.Literal("attributeKeys"),
    source: Schema.Literals(["traces", "logs", "metrics"]),
    data: Schema.Array(AttributeKeyItem),
  }),
  Schema.Struct({
    kind: Schema.Literal("facets"),
    source: Schema.Literals(["traces", "logs", "errors", "services"]),
    data: Schema.Array(FacetItem),
  }),
  Schema.Struct({
    kind: Schema.Literal("stats"),
    source: Schema.Literal("traces"),
    data: DurationStats,
  }),
  Schema.Struct({
    kind: Schema.Literal("attributeValues"),
    source: Schema.Literal("traces"),
    data: Schema.Array(AttributeValueItem),
  }),
  Schema.Struct({
    kind: Schema.Literal("count"),
    source: Schema.Literal("logs"),
    data: Schema.Struct({ total: Schema.Number }),
  }),
])
export type QueryEngineResult = Schema.Schema.Type<typeof QueryEngineResult>

export class QueryEngineExecuteResponse extends Schema.Class<QueryEngineExecuteResponse>(
  "QueryEngineExecuteResponse",
)({
  result: QueryEngineResult,
}) {}

export const QueryEngineAlertReducer = Schema.Literals([
  "identity",
  "sum",
  "avg",
  "min",
  "max",
]).annotate({
  identifier: "@maple/QueryEngineAlertReducer",
})
export type QueryEngineAlertReducer = Schema.Schema.Type<
  typeof QueryEngineAlertReducer
>

export const QueryEngineSampleCountStrategy = Schema.Literals([
  "trace_count",
  "metric_data_points",
  "log_count",
]).annotate({
  identifier: "@maple/QueryEngineSampleCountStrategy",
})
export type QueryEngineSampleCountStrategy = Schema.Schema.Type<
  typeof QueryEngineSampleCountStrategy
>

export const QueryEngineNoDataBehavior = Schema.Literals([
  "skip",
  "zero",
]).annotate({
  identifier: "@maple/QueryEngineNoDataBehavior",
})
export type QueryEngineNoDataBehavior = Schema.Schema.Type<
  typeof QueryEngineNoDataBehavior
>

export const QueryEngineAlertObservation = Schema.Struct({
  value: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
  hasData: Schema.Boolean,
  label: Schema.optional(Schema.String),
})
export type QueryEngineAlertObservation = Schema.Schema.Type<
  typeof QueryEngineAlertObservation
>

export class QueryEngineEvaluateRequest extends Schema.Class<QueryEngineEvaluateRequest>(
  "QueryEngineEvaluateRequest",
)({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  query: QuerySpec,
  reducer: QueryEngineAlertReducer,
  sampleCountStrategy: QueryEngineSampleCountStrategy,
}) {}

export class QueryEngineEvaluateResponse extends Schema.Class<QueryEngineEvaluateResponse>(
  "QueryEngineEvaluateResponse",
)({
  value: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
  hasData: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  reducer: QueryEngineAlertReducer,
  observations: Schema.Array(QueryEngineAlertObservation),
}) {}

export class CompiledAlertQueryPlan extends Schema.Class<CompiledAlertQueryPlan>(
  "CompiledAlertQueryPlan",
)({
  query: QuerySpec,
  reducer: QueryEngineAlertReducer,
  sampleCountStrategy: QueryEngineSampleCountStrategy,
  noDataBehavior: QueryEngineNoDataBehavior,
}) {}
