import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { QueryEngineExecuteRequest, QueryEngineExecuteResponse, TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"

// ---------------------------------------------------------------------------
// Dedicated endpoint schemas
// ---------------------------------------------------------------------------

export class SpanHierarchyRequest extends Schema.Class<SpanHierarchyRequest>("SpanHierarchyRequest")({
  traceId: Schema.String,
  spanId: Schema.optional(Schema.String),
}) {}

export class SpanHierarchyResponse extends Schema.Class<SpanHierarchyResponse>("SpanHierarchyResponse")({
  data: Schema.Array(Schema.Struct({
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.String,
    spanName: Schema.String,
    serviceName: Schema.String,
    spanKind: Schema.String,
    durationMs: Schema.Number,
    startTime: Schema.String,
    statusCode: Schema.String,
    statusMessage: Schema.String,
    spanAttributes: Schema.String,
    resourceAttributes: Schema.String,
  })),
}) {}

const OptionalStringArray = Schema.optional(Schema.Array(Schema.String))

export class ErrorsByTypeRequest extends Schema.Class<ErrorsByTypeRequest>("ErrorsByTypeRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  rootOnly: Schema.optional(Schema.Boolean),
  services: OptionalStringArray,
  deploymentEnvs: OptionalStringArray,
  errorTypes: OptionalStringArray,
  limit: Schema.optional(Schema.Number),
}) {}

export class ErrorsByTypeResponse extends Schema.Class<ErrorsByTypeResponse>("ErrorsByTypeResponse")({
  data: Schema.Array(Schema.Struct({
    errorType: Schema.String,
    sampleMessage: Schema.String,
    count: Schema.Number,
    affectedServicesCount: Schema.Number,
    firstSeen: Schema.String,
    lastSeen: Schema.String,
  })),
}) {}

export class ErrorsTimeseriesRequest extends Schema.Class<ErrorsTimeseriesRequest>("ErrorsTimeseriesRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  errorType: Schema.String,
  services: OptionalStringArray,
  bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ErrorsTimeseriesResponse extends Schema.Class<ErrorsTimeseriesResponse>("ErrorsTimeseriesResponse")({
  data: Schema.Array(Schema.Struct({
    bucket: Schema.String,
    count: Schema.Number,
  })),
}) {}

export class ErrorsSummaryRequest extends Schema.Class<ErrorsSummaryRequest>("ErrorsSummaryRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  rootOnly: Schema.optional(Schema.Boolean),
  services: OptionalStringArray,
  deploymentEnvs: OptionalStringArray,
  errorTypes: OptionalStringArray,
}) {}

export class ErrorsSummaryResponse extends Schema.Class<ErrorsSummaryResponse>("ErrorsSummaryResponse")({
  data: Schema.NullOr(Schema.Struct({
    totalErrors: Schema.Number,
    totalSpans: Schema.Number,
    errorRate: Schema.Number,
    affectedServicesCount: Schema.Number,
    affectedTracesCount: Schema.Number,
  })),
}) {}

export class ErrorDetailTracesRequest extends Schema.Class<ErrorDetailTracesRequest>("ErrorDetailTracesRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  errorType: Schema.String,
  rootOnly: Schema.optional(Schema.Boolean),
  services: OptionalStringArray,
  limit: Schema.optional(Schema.Number),
}) {}

export class ErrorDetailTracesResponse extends Schema.Class<ErrorDetailTracesResponse>("ErrorDetailTracesResponse")({
  data: Schema.Array(Schema.Struct({
    traceId: Schema.String,
    startTime: Schema.String,
    durationMicros: Schema.Number,
    spanCount: Schema.Number,
    services: Schema.Array(Schema.String),
    rootSpanName: Schema.String,
    errorMessage: Schema.String,
  })),
}) {}

export class ErrorRateByServiceRequest extends Schema.Class<ErrorRateByServiceRequest>("ErrorRateByServiceRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
}) {}

export class ErrorRateByServiceResponse extends Schema.Class<ErrorRateByServiceResponse>("ErrorRateByServiceResponse")({
  data: Schema.Array(Schema.Struct({
    serviceName: Schema.String,
    totalLogs: Schema.Number,
    errorLogs: Schema.Number,
    errorRate: Schema.Number,
  })),
}) {}

export class ServiceOverviewRequest extends Schema.Class<ServiceOverviewRequest>("ServiceOverviewRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  environments: OptionalStringArray,
  commitShas: OptionalStringArray,
}) {}

export class ServiceOverviewResponse extends Schema.Class<ServiceOverviewResponse>("ServiceOverviewResponse")({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceApdexRequest extends Schema.Class<ServiceApdexRequest>("ServiceApdexRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  serviceName: Schema.String,
  apdexThresholdMs: Schema.optional(Schema.Number),
  bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ServiceApdexResponse extends Schema.Class<ServiceApdexResponse>("ServiceApdexResponse")({
  data: Schema.Array(Schema.Struct({
    bucket: Schema.String,
    totalCount: Schema.Number,
    satisfiedCount: Schema.Number,
    toleratingCount: Schema.Number,
    apdexScore: Schema.Number,
  })),
}) {}

export class ServiceReleasesRequest extends Schema.Class<ServiceReleasesRequest>("ServiceReleasesRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  serviceName: Schema.String,
  bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ServiceReleasesResponse extends Schema.Class<ServiceReleasesResponse>("ServiceReleasesResponse")({
  data: Schema.Array(Schema.Struct({
    bucket: Schema.String,
    commitSha: Schema.String,
    count: Schema.Number,
  })),
}) {}

export class ServiceDependenciesRequest extends Schema.Class<ServiceDependenciesRequest>("ServiceDependenciesRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  deploymentEnv: Schema.optional(Schema.String),
}) {}

export class ServiceDependenciesResponse extends Schema.Class<ServiceDependenciesResponse>("ServiceDependenciesResponse")({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceUsageRequest extends Schema.Class<ServiceUsageRequest>("ServiceUsageRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  service: Schema.optional(Schema.String),
}) {}

export class ServiceUsageResponse extends Schema.Class<ServiceUsageResponse>("ServiceUsageResponse")({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListLogsRequest extends Schema.Class<ListLogsRequest>("ListLogsRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  minSeverity: Schema.optional(Schema.Number),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  deploymentEnv: Schema.optional(Schema.String),
  deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
  limit: Schema.optional(Schema.Number),
}) {}

export class ListLogsResponse extends Schema.Class<ListLogsResponse>("ListLogsResponse")({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListMetricsRequest extends Schema.Class<ListMetricsRequest>("ListMetricsRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  service: Schema.optional(Schema.String),
  metricType: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
}) {}

export class ListMetricsResponse extends Schema.Class<ListMetricsResponse>("ListMetricsResponse")({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class MetricsSummaryRequest extends Schema.Class<MetricsSummaryRequest>("MetricsSummaryRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  service: Schema.optional(Schema.String),
}) {}

export class MetricsSummaryResponse extends Schema.Class<MetricsSummaryResponse>("MetricsSummaryResponse")({
  data: Schema.Array(Schema.Struct({
    metricType: Schema.String,
    metricCount: Schema.Number,
    dataPointCount: Schema.Number,
  })),
}) {}

// ---------------------------------------------------------------------------
// Query Builder execute (used by dashboards' custom_query_builder_* widgets)
// ---------------------------------------------------------------------------

const QueryBuilderAddOnsSchema = Schema.Struct({
  groupBy: Schema.Boolean,
  having: Schema.Boolean,
  orderBy: Schema.Boolean,
  limit: Schema.Boolean,
  legend: Schema.Boolean,
})

export const QueryBuilderQueryDraftSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  dataSource: Schema.Literals(["traces", "logs", "metrics"]),
  signalSource: Schema.optional(Schema.Literals(["default", "meter"])),
  metricName: Schema.String,
  metricType: Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"]),
  isMonotonic: Schema.optional(Schema.Boolean),
  whereClause: Schema.String,
  aggregation: Schema.String,
  stepInterval: Schema.String,
  orderByDirection: Schema.optional(Schema.Literals(["desc", "asc"])),
  addOns: QueryBuilderAddOnsSchema,
  groupBy: Schema.mutable(Schema.Array(Schema.String)),
  having: Schema.optional(Schema.String),
  orderBy: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  legend: Schema.optional(Schema.String),
})
export type QueryBuilderQueryDraftPayload = Schema.Schema.Type<typeof QueryBuilderQueryDraftSchema>

export class ExecuteQueryBuilderRequest extends Schema.Class<ExecuteQueryBuilderRequest>("ExecuteQueryBuilderRequest")({
  startTime: TinybirdDateTime,
  endTime: TinybirdDateTime,
  kind: Schema.Literals(["timeseries", "breakdown"]),
  queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
}) {}

const QueryBuilderTimeseriesPoint = Schema.Struct({
  bucket: Schema.String,
  series: Schema.Record(Schema.String, Schema.Number),
})

const QueryBuilderBreakdownItem = Schema.Struct({
  name: Schema.String,
  value: Schema.Number,
})

export class ExecuteQueryBuilderResponse extends Schema.Class<ExecuteQueryBuilderResponse>("ExecuteQueryBuilderResponse")({
  result: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("timeseries"),
      data: Schema.Array(QueryBuilderTimeseriesPoint),
    }),
    Schema.Struct({
      kind: Schema.Literal("breakdown"),
      data: Schema.Array(QueryBuilderBreakdownItem),
    }),
  ]),
  warnings: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class QueryEngineValidationError extends Schema.TaggedErrorClass<QueryEngineValidationError>()(
  "@maple/http/errors/QueryEngineValidationError",
  {
    message: Schema.String,
    details: Schema.Array(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class QueryEngineExecutionError extends Schema.TaggedErrorClass<QueryEngineExecutionError>()(
  "@maple/http/errors/QueryEngineExecutionError",
  {
    message: Schema.String,
    causeTag: Schema.optional(Schema.String),
    pipe: Schema.optional(Schema.String),
  },
  { httpApiStatus: 502 },
) {}

export class QueryEngineTimeoutError extends Schema.TaggedErrorClass<QueryEngineTimeoutError>()(
  "@maple/http/errors/QueryEngineTimeoutError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 504 },
) {}

export class QueryEngineApiGroup extends HttpApiGroup.make("queryEngine")
  .add(
    HttpApiEndpoint.post("execute", "/execute", {
      payload: QueryEngineExecuteRequest,
      success: QueryEngineExecuteResponse,
      error: [QueryEngineValidationError, QueryEngineExecutionError, QueryEngineTimeoutError],
    }),
  )
  .add(HttpApiEndpoint.post("spanHierarchy", "/span-hierarchy", {
    payload: SpanHierarchyRequest, success: SpanHierarchyResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("errorsByType", "/errors-by-type", {
    payload: ErrorsByTypeRequest, success: ErrorsByTypeResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("errorsTimeseries", "/errors-timeseries", {
    payload: ErrorsTimeseriesRequest, success: ErrorsTimeseriesResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("errorsSummary", "/errors-summary", {
    payload: ErrorsSummaryRequest, success: ErrorsSummaryResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("errorDetailTraces", "/error-detail-traces", {
    payload: ErrorDetailTracesRequest, success: ErrorDetailTracesResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("errorRateByService", "/error-rate-by-service", {
    payload: ErrorRateByServiceRequest, success: ErrorRateByServiceResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("serviceOverview", "/service-overview", {
    payload: ServiceOverviewRequest, success: ServiceOverviewResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("serviceApdex", "/service-apdex", {
    payload: ServiceApdexRequest, success: ServiceApdexResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("serviceReleases", "/service-releases", {
    payload: ServiceReleasesRequest, success: ServiceReleasesResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("serviceDependencies", "/service-dependencies", {
    payload: ServiceDependenciesRequest, success: ServiceDependenciesResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("serviceUsage", "/service-usage", {
    payload: ServiceUsageRequest, success: ServiceUsageResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("listLogs", "/list-logs", {
    payload: ListLogsRequest, success: ListLogsResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("listMetrics", "/list-metrics", {
    payload: ListMetricsRequest, success: ListMetricsResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("metricsSummary", "/metrics-summary", {
    payload: MetricsSummaryRequest, success: MetricsSummaryResponse,
    error: [QueryEngineExecutionError],
  }))
  .add(HttpApiEndpoint.post("executeQueryBuilder", "/execute-query-builder", {
    payload: ExecuteQueryBuilderRequest,
    success: ExecuteQueryBuilderResponse,
    error: [QueryEngineValidationError, QueryEngineExecutionError, QueryEngineTimeoutError],
  }))
  .prefix("/api/query-engine")
  .middleware(Authorization) {}
