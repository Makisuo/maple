import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export { UnauthorizedError } from "./current-tenant"

// --- Shared schemas ---

const TimeRange = Schema.Struct({
  startTime: Schema.String,
  endTime: Schema.String,
})

const AttributeFilter = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  mode: Schema.optionalKey(Schema.String),
})

// --- List Services ---

const ListServicesRequest = Schema.Struct({
  timeRange: TimeRange,
  environment: Schema.optionalKey(Schema.String),
})

const ServiceSummary = Schema.Struct({
  name: Schema.String,
  throughput: Schema.Number,
  errorRate: Schema.Number,
  errorCount: Schema.Number,
  p50Ms: Schema.Number,
  p95Ms: Schema.Number,
  p99Ms: Schema.Number,
})

const ListServicesResponse = Schema.Struct({
  services: Schema.Array(ServiceSummary),
})

// --- Search Traces ---

const SearchTracesRequest = Schema.Struct({
  timeRange: TimeRange,
  service: Schema.optionalKey(Schema.String),
  spanName: Schema.optionalKey(Schema.String),
  spanNameMatchMode: Schema.optionalKey(Schema.Literals(["exact", "contains"])),
  hasError: Schema.optionalKey(Schema.Boolean),
  minDurationMs: Schema.optionalKey(Schema.Number),
  maxDurationMs: Schema.optionalKey(Schema.Number),
  httpMethod: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  attributeFilters: Schema.optionalKey(Schema.Array(AttributeFilter)),
  rootOnly: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

const SpanResult = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.NullOr(Schema.String),
  spanName: Schema.String,
  serviceName: Schema.String,
  durationMs: Schema.Number,
  statusCode: Schema.String,
  statusMessage: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  resourceAttributes: Schema.Record(Schema.String, Schema.String),
  timestamp: Schema.String,
})

const SearchTracesResponse = Schema.Struct({
  timeRange: TimeRange,
  spans: Schema.Array(SpanResult),
  pagination: Schema.Struct({
    offset: Schema.Number,
    limit: Schema.Number,
    hasMore: Schema.Boolean,
  }),
})

// --- Inspect Trace ---

const InspectTraceRequest = Schema.Struct({
  traceId: Schema.String,
})

const LogEntry = Schema.Struct({
  timestamp: Schema.String,
  severityText: Schema.String,
  serviceName: Schema.String,
  body: Schema.String,
  spanId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
})

interface SpanNodeResponse {
  readonly spanId: string
  readonly parentSpanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly durationMs: number
  readonly statusCode: string
  readonly statusMessage: string
  readonly attributes: Record<string, string>
  readonly resourceAttributes: Record<string, string>
  readonly children: ReadonlyArray<SpanNodeResponse>
}

const SpanNode: Schema.Codec<SpanNodeResponse> = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.String,
  spanName: Schema.String,
  serviceName: Schema.String,
  durationMs: Schema.Number,
  statusCode: Schema.String,
  statusMessage: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  resourceAttributes: Schema.Record(Schema.String, Schema.String),
  children: Schema.Array(Schema.suspend((): Schema.Codec<SpanNodeResponse> => SpanNode)),
})

const InspectTraceResponse = Schema.Struct({
  traceId: Schema.String,
  serviceCount: Schema.Number,
  spanCount: Schema.Number,
  rootDurationMs: Schema.Number,
  spans: Schema.Array(SpanNode),
  logs: Schema.Array(LogEntry),
})

// --- Find Errors ---

const FindErrorsRequest = Schema.Struct({
  timeRange: TimeRange,
  service: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
})

const ErrorSummary = Schema.Struct({
  errorType: Schema.String,
  count: Schema.Number,
  affectedServicesCount: Schema.Number,
  lastSeen: Schema.String,
})

const FindErrorsResponse = Schema.Struct({
  errors: Schema.Array(ErrorSummary),
})

// --- Diagnose Service ---

const DiagnoseServiceRequest = Schema.Struct({
  serviceName: Schema.String,
  timeRange: TimeRange,
  environment: Schema.optionalKey(Schema.String),
})

const DiagnoseServiceResponse = Schema.Struct({
  serviceName: Schema.String,
  timeRange: TimeRange,
  health: Schema.Struct({
    throughput: Schema.Number,
    errorRate: Schema.Number,
    errorCount: Schema.Number,
    p50Ms: Schema.Number,
    p95Ms: Schema.Number,
    p99Ms: Schema.Number,
    apdex: Schema.Number,
  }),
  topErrors: Schema.Array(Schema.Struct({
    errorType: Schema.String,
    count: Schema.Number,
  })),
  recentTraces: Schema.Array(Schema.Struct({
    traceId: Schema.String,
    rootSpanName: Schema.String,
    durationMs: Schema.Number,
    hasError: Schema.Boolean,
  })),
  recentLogs: Schema.Array(LogEntry),
})

// --- Search Logs ---

const SearchLogsRequest = Schema.Struct({
  timeRange: TimeRange,
  service: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

const SearchLogsResponse = Schema.Struct({
  timeRange: TimeRange,
  total: Schema.Number,
  logs: Schema.Array(LogEntry),
  pagination: Schema.Struct({
    offset: Schema.Number,
    limit: Schema.Number,
    hasMore: Schema.Boolean,
  }),
})

// --- Error class ---

export class ObservabilityApiError extends Schema.TaggedErrorClass<ObservabilityApiError>()(
  "@maple/http/errors/ObservabilityApiError",
  {
    message: Schema.String,
    pipe: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect),
  },
  { httpApiStatus: 500 },
) {}

// --- API Group ---

export class ObservabilityApiGroup extends HttpApiGroup.make("observability")
  .add(HttpApiEndpoint.post("listServices", "/services", {
    payload: ListServicesRequest,
    success: ListServicesResponse,
    error: ObservabilityApiError,
  }))
  .add(HttpApiEndpoint.post("searchTraces", "/traces/search", {
    payload: SearchTracesRequest,
    success: SearchTracesResponse,
    error: ObservabilityApiError,
  }))
  .add(HttpApiEndpoint.post("inspectTrace", "/traces/inspect", {
    payload: InspectTraceRequest,
    success: InspectTraceResponse,
    error: ObservabilityApiError,
  }))
  .add(HttpApiEndpoint.post("findErrors", "/errors", {
    payload: FindErrorsRequest,
    success: FindErrorsResponse,
    error: ObservabilityApiError,
  }))
  .add(HttpApiEndpoint.post("diagnoseService", "/diagnose", {
    payload: DiagnoseServiceRequest,
    success: DiagnoseServiceResponse,
    error: ObservabilityApiError,
  }))
  .add(HttpApiEndpoint.post("searchLogs", "/logs", {
    payload: SearchLogsRequest,
    success: SearchLogsResponse,
    error: ObservabilityApiError,
  }))
  .prefix("/api/observability")
  .middleware(Authorization) {}
