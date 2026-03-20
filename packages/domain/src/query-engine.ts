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
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
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
    Schema.Literals([
      "service",
      "span_name",
      "status_code",
      "http_method",
      "attribute",
      "none",
    ]),
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
  groupBy: Schema.optional(Schema.Literals(["service", "severity", "none"])),
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
  groupBy: Schema.optional(Schema.Literals(["service", "none"])),
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

export const QueryBuilderSignal = Schema.Literals(["traces", "logs", "metrics"])
export type QueryBuilderSignal = Schema.Schema.Type<typeof QueryBuilderSignal>

export const QueryBuilderExecutionKind = Schema.Literals(["timeseries", "breakdown"])
export type QueryBuilderExecutionKind = Schema.Schema.Type<typeof QueryBuilderExecutionKind>

export const QueryBuilderFieldType = Schema.Literals(["string", "number", "boolean"])
export type QueryBuilderFieldType = Schema.Schema.Type<typeof QueryBuilderFieldType>

export const QueryBuilderFieldOrigin = Schema.Literals([
  "intrinsic",
  "span_attribute",
  "resource_attribute",
  "log_attribute",
  "metric_attribute",
])
export type QueryBuilderFieldOrigin = Schema.Schema.Type<typeof QueryBuilderFieldOrigin>

export const QueryBuilderFilterOperator = Schema.Literals([
  "=",
  "!=",
  "IN",
  "NOT IN",
  "CONTAINS",
  "NOT CONTAINS",
  ">",
  ">=",
  "<",
  "<=",
])
export type QueryBuilderFilterOperator = Schema.Schema.Type<typeof QueryBuilderFilterOperator>

const QueryBuilderScalarValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
])
export type QueryBuilderScalarValue = Schema.Schema.Type<typeof QueryBuilderScalarValue>

export interface QueryBuilderFilterGroupNode {
  readonly kind: "group"
  readonly operator: "AND" | "OR"
  readonly clauses: ReadonlyArray<QueryBuilderFilterNode>
}

export interface QueryBuilderFilterComparisonNode {
  readonly kind: "comparison"
  readonly field: string
  readonly operator: QueryBuilderFilterOperator
  readonly value: QueryBuilderScalarValue | ReadonlyArray<QueryBuilderScalarValue>
}

export interface QueryBuilderFilterExistsNode {
  readonly kind: "exists"
  readonly field: string
  readonly negated?: boolean
}

export type QueryBuilderFilterNode =
  | QueryBuilderFilterGroupNode
  | QueryBuilderFilterComparisonNode
  | QueryBuilderFilterExistsNode

export const QueryBuilderFilterNode: Schema.Schema<QueryBuilderFilterNode> = Schema.suspend(
  () =>
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("group"),
        operator: Schema.Literals(["AND", "OR"]),
        clauses: Schema.Array(QueryBuilderFilterNode),
      }),
      Schema.Struct({
        kind: Schema.Literal("comparison"),
        field: Schema.String,
        operator: QueryBuilderFilterOperator,
        value: Schema.Union([
          QueryBuilderScalarValue,
          Schema.Array(QueryBuilderScalarValue),
        ]),
      }),
      Schema.Struct({
        kind: Schema.Literal("exists"),
        field: Schema.String,
        negated: Schema.optional(Schema.Boolean),
      }),
    ]),
)

export const QueryBuilderOrderBy = Schema.Struct({
  field: Schema.String,
  direction: Schema.Literals(["asc", "desc"]),
})
export type QueryBuilderOrderBy = Schema.Schema.Type<typeof QueryBuilderOrderBy>

export const QueryBuilderRequest = Schema.Struct({
  kind: QueryBuilderExecutionKind,
  signal: QueryBuilderSignal,
  metric: Schema.String,
  metricName: Schema.optional(Schema.String),
  metricType: Schema.optional(MetricType),
  filters: Schema.optional(QueryBuilderFilterNode),
  having: Schema.optional(QueryBuilderFilterNode),
  groupBy: Schema.optional(Schema.Array(Schema.String)),
  orderBy: Schema.optional(QueryBuilderOrderBy),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
  bucketSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  allowSlowPath: Schema.optional(Schema.Boolean),
})
export type QueryBuilderRequest = Schema.Schema.Type<typeof QueryBuilderRequest>

export class QueryBuilderPlanRequest extends Schema.Class<QueryBuilderPlanRequest>(
  "QueryBuilderPlanRequest",
)({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  query: QueryBuilderRequest,
}) {}

export class QueryBuilderExecuteRequest extends Schema.Class<QueryBuilderExecuteRequest>(
  "QueryBuilderExecuteRequest",
)({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  query: QueryBuilderRequest,
}) {}

export const QueryBuilderPlannerClassification = Schema.Literals([
  "sync_fast",
  "sync_bounded",
])
export type QueryBuilderPlannerClassification = Schema.Schema.Type<
  typeof QueryBuilderPlannerClassification
>

export const QueryBuilderPlannerReasonCode = Schema.Literals([
  "fast_path_eligible",
  "dynamic_field_scan",
  "boolean_expression",
  "percentile_large_range",
  "series_limit_applied",
  "bucket_limit_applied",
  "unsupported_field",
  "unsupported_metric",
  "invalid_query",
  "slow_path_confirmation_required",
])
export type QueryBuilderPlannerReasonCode = Schema.Schema.Type<
  typeof QueryBuilderPlannerReasonCode
>

export const QueryBuilderPlannerReason = Schema.Struct({
  code: QueryBuilderPlannerReasonCode,
  message: Schema.String,
})
export type QueryBuilderPlannerReason = Schema.Schema.Type<
  typeof QueryBuilderPlannerReason
>

export const QueryBuilderPlanResult = Schema.Struct({
  classification: QueryBuilderPlannerClassification,
  executionPath: Schema.String,
  normalizedQuery: QueryBuilderRequest,
  estimatedBuckets: Schema.Number,
  estimatedSeriesLimit: Schema.Number,
  warnings: Schema.Array(QueryBuilderPlannerReason),
})
export type QueryBuilderPlanResult = Schema.Schema.Type<typeof QueryBuilderPlanResult>

export class QueryBuilderPlanResponse extends Schema.Class<QueryBuilderPlanResponse>(
  "QueryBuilderPlanResponse",
)({
  plan: QueryBuilderPlanResult,
}) {}

export const QueryBuilderFieldCapability = Schema.Struct({
  filterable: Schema.Boolean,
  groupable: Schema.Boolean,
  aggregatable: Schema.Boolean,
  fastPath: Schema.Boolean,
})
export type QueryBuilderFieldCapability = Schema.Schema.Type<
  typeof QueryBuilderFieldCapability
>

export const QueryBuilderFieldMetadata = Schema.Struct({
  signal: QueryBuilderSignal,
  path: Schema.String,
  label: Schema.String,
  type: QueryBuilderFieldType,
  origin: QueryBuilderFieldOrigin,
  capability: QueryBuilderFieldCapability,
})
export type QueryBuilderFieldMetadata = Schema.Schema.Type<
  typeof QueryBuilderFieldMetadata
>

export class QueryBuilderMetadataRequest extends Schema.Class<QueryBuilderMetadataRequest>(
  "QueryBuilderMetadataRequest",
)({
  signal: QueryBuilderSignal,
  startTime: Schema.optional(TinybirdDateTime),
  endTime: Schema.optional(TinybirdDateTime),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(500),
    ),
  ),
}) {}

export class QueryBuilderMetadataResponse extends Schema.Class<QueryBuilderMetadataResponse>(
  "QueryBuilderMetadataResponse",
)({
  fields: Schema.Array(QueryBuilderFieldMetadata),
}) {}

export class QueryBuilderFieldValuesRequest extends Schema.Class<QueryBuilderFieldValuesRequest>(
  "QueryBuilderFieldValuesRequest",
)({
  signal: QueryBuilderSignal,
  field: Schema.String,
  startTime: Schema.optional(TinybirdDateTime),
  endTime: Schema.optional(TinybirdDateTime),
  query: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
}) {}

export class QueryBuilderFieldValuesResponse extends Schema.Class<QueryBuilderFieldValuesResponse>(
  "QueryBuilderFieldValuesResponse",
)({
  values: Schema.Array(Schema.String),
}) {}

export class QueryBuilderExecuteResponse extends Schema.Class<QueryBuilderExecuteResponse>(
  "QueryBuilderExecuteResponse",
)({
  plan: QueryBuilderPlanResult,
  result: QueryEngineResult,
}) {}
