import { Schema } from "effect"

export const TimeRange = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
})
export type TimeRange = Schema.Schema.Type<typeof TimeRange>

export const TraceRow = Schema.Struct({
  traceId: Schema.String,
  rootSpanName: Schema.String,
  durationMs: Schema.Number,
  spanCount: Schema.Number,
  services: Schema.Array(Schema.String),
  hasError: Schema.Boolean,
  startTime: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type TraceRow = Schema.Schema.Type<typeof TraceRow>

export const LogRow = Schema.Struct({
  timestamp: Schema.String,
  severityText: Schema.String,
  serviceName: Schema.String,
  body: Schema.String,
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
})
export type LogRow = Schema.Schema.Type<typeof LogRow>

export const SystemHealthData = Schema.Struct({
  timeRange: TimeRange,
  serviceCount: Schema.Number,
  totalSpans: Schema.Number,
  totalErrors: Schema.Number,
  errorRate: Schema.Number,
  affectedServicesCount: Schema.Number,
  affectedTracesCount: Schema.Number,
  latency: Schema.Struct({
    p50Ms: Schema.Number,
    p95Ms: Schema.Number,
  }),
  topErrors: Schema.Array(
    Schema.Struct({
      errorType: Schema.String,
      count: Schema.Number,
      affectedServicesCount: Schema.Number,
    }),
  ),
})
export type SystemHealthData = Schema.Schema.Type<typeof SystemHealthData>

export const ServiceOverviewData = Schema.Struct({
  timeRange: TimeRange,
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      throughput: Schema.Number,
      errorRate: Schema.Number,
      p50Ms: Schema.Number,
      p95Ms: Schema.Number,
      p99Ms: Schema.Number,
    }),
  ),
  dataVolume: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        traces: Schema.Number,
        logs: Schema.Number,
        metrics: Schema.Number,
      }),
    ),
  ),
})
export type ServiceOverviewData = Schema.Schema.Type<typeof ServiceOverviewData>

export const SearchTracesData = Schema.Struct({
  timeRange: TimeRange,
  traces: Schema.Array(TraceRow),
})
export type SearchTracesData = Schema.Schema.Type<typeof SearchTracesData>

export const FindSlowTracesData = Schema.Struct({
  timeRange: TimeRange,
  stats: Schema.optional(
    Schema.Struct({
      p50Ms: Schema.Number,
      p95Ms: Schema.Number,
      minMs: Schema.Number,
      maxMs: Schema.Number,
    }),
  ),
  traces: Schema.Array(TraceRow),
})
export type FindSlowTracesData = Schema.Schema.Type<typeof FindSlowTracesData>

export const ErrorTypeRow = Schema.Struct({
  errorType: Schema.String,
  count: Schema.Number,
  affectedServices: Schema.Array(Schema.String),
  lastSeen: Schema.String,
})
export type ErrorTypeRow = Schema.Schema.Type<typeof ErrorTypeRow>

export const FindErrorsData = Schema.Struct({
  timeRange: TimeRange,
  errors: Schema.Array(ErrorTypeRow),
})
export type FindErrorsData = Schema.Schema.Type<typeof FindErrorsData>

export const ErrorDetailTrace = Schema.Struct({
  traceId: Schema.String,
  rootSpanName: Schema.String,
  durationMs: Schema.Number,
  spanCount: Schema.Number,
  services: Schema.Array(Schema.String),
  startTime: Schema.String,
  errorMessage: Schema.optional(Schema.String),
  logs: Schema.Array(
    Schema.Struct({
      timestamp: Schema.String,
      severityText: Schema.String,
      body: Schema.String,
    }),
  ),
})
export type ErrorDetailTrace = Schema.Schema.Type<typeof ErrorDetailTrace>

export const ErrorDetailData = Schema.Struct({
  timeRange: TimeRange,
  errorType: Schema.String,
  traces: Schema.Array(ErrorDetailTrace),
})
export type ErrorDetailData = Schema.Schema.Type<typeof ErrorDetailData>

export class SpanNodeData extends Schema.Class<SpanNodeData>("SpanNodeData")(
  Schema.Struct({
    spanId: Schema.String,
    parentSpanId: Schema.String,
    spanName: Schema.String,
    serviceName: Schema.String,
    durationMs: Schema.Number,
    statusCode: Schema.String,
    statusMessage: Schema.String,
    children: Schema.Array(Schema.suspend((): Schema.Codec<SpanNodeData> => SpanNodeData)),
  }),
) {}

export const InspectTraceData = Schema.Struct({
  traceId: Schema.String,
  serviceCount: Schema.Number,
  spanCount: Schema.Number,
  rootDurationMs: Schema.Number,
  spans: Schema.Array(SpanNodeData),
  logs: Schema.Array(LogRow),
})
export type InspectTraceData = Schema.Schema.Type<typeof InspectTraceData>

export const SearchLogsData = Schema.Struct({
  timeRange: TimeRange,
  totalCount: Schema.Number,
  logs: Schema.Array(LogRow),
  filters: Schema.optional(
    Schema.Struct({
      service: Schema.optional(Schema.String),
      severity: Schema.optional(Schema.String),
      search: Schema.optional(Schema.String),
      traceId: Schema.optional(Schema.String),
    }),
  ),
})
export type SearchLogsData = Schema.Schema.Type<typeof SearchLogsData>

export const DiagnoseServiceData = Schema.Struct({
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
  topErrors: Schema.Array(
    Schema.Struct({
      errorType: Schema.String,
      count: Schema.Number,
    }),
  ),
  recentTraces: Schema.Array(TraceRow),
  recentLogs: Schema.Array(LogRow),
})
export type DiagnoseServiceData = Schema.Schema.Type<typeof DiagnoseServiceData>

export const MetricRow = Schema.Struct({
  metricName: Schema.String,
  metricType: Schema.String,
  serviceName: Schema.String,
  metricUnit: Schema.String,
  dataPointCount: Schema.Number,
})
export type MetricRow = Schema.Schema.Type<typeof MetricRow>

export const ListMetricsData = Schema.Struct({
  timeRange: TimeRange,
  summary: Schema.Array(
    Schema.Struct({
      metricType: Schema.String,
      metricCount: Schema.Number,
      dataPointCount: Schema.Number,
    }),
  ),
  metrics: Schema.Array(MetricRow),
})
export type ListMetricsData = Schema.Schema.Type<typeof ListMetricsData>

export const QueryDataData = Schema.Struct({
  timeRange: TimeRange,
  source: Schema.String,
  kind: Schema.String,
  metric: Schema.String,
  groupBy: Schema.optional(Schema.String),
  result: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("timeseries"),
      data: Schema.Array(
        Schema.Struct({
          bucket: Schema.String,
          series: Schema.Record(Schema.String, Schema.Number),
        }),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal("breakdown"),
      data: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          value: Schema.Number,
        }),
      ),
    }),
  ]),
})
export type QueryDataData = Schema.Schema.Type<typeof QueryDataData>

export const SystemHealthToolOutput = Schema.Struct({
  tool: Schema.Literal("system_health"),
  summaryText: Schema.String,
  data: SystemHealthData,
})
export type SystemHealthToolOutput = Schema.Schema.Type<typeof SystemHealthToolOutput>

export const ServiceOverviewToolOutput = Schema.Struct({
  tool: Schema.Literal("service_overview"),
  summaryText: Schema.String,
  data: ServiceOverviewData,
})
export type ServiceOverviewToolOutput = Schema.Schema.Type<typeof ServiceOverviewToolOutput>

export const SearchTracesToolOutput = Schema.Struct({
  tool: Schema.Literal("search_traces"),
  summaryText: Schema.String,
  data: SearchTracesData,
})
export type SearchTracesToolOutput = Schema.Schema.Type<typeof SearchTracesToolOutput>

export const FindSlowTracesToolOutput = Schema.Struct({
  tool: Schema.Literal("find_slow_traces"),
  summaryText: Schema.String,
  data: FindSlowTracesData,
})
export type FindSlowTracesToolOutput = Schema.Schema.Type<typeof FindSlowTracesToolOutput>

export const FindErrorsToolOutput = Schema.Struct({
  tool: Schema.Literal("find_errors"),
  summaryText: Schema.String,
  data: FindErrorsData,
})
export type FindErrorsToolOutput = Schema.Schema.Type<typeof FindErrorsToolOutput>

export const ErrorDetailToolOutput = Schema.Struct({
  tool: Schema.Literal("error_detail"),
  summaryText: Schema.String,
  data: ErrorDetailData,
})
export type ErrorDetailToolOutput = Schema.Schema.Type<typeof ErrorDetailToolOutput>

export const InspectTraceToolOutput = Schema.Struct({
  tool: Schema.Literal("inspect_trace"),
  summaryText: Schema.String,
  data: InspectTraceData,
})
export type InspectTraceToolOutput = Schema.Schema.Type<typeof InspectTraceToolOutput>

export const SearchLogsToolOutput = Schema.Struct({
  tool: Schema.Literal("search_logs"),
  summaryText: Schema.String,
  data: SearchLogsData,
})
export type SearchLogsToolOutput = Schema.Schema.Type<typeof SearchLogsToolOutput>

export const DiagnoseServiceToolOutput = Schema.Struct({
  tool: Schema.Literal("diagnose_service"),
  summaryText: Schema.String,
  data: DiagnoseServiceData,
})
export type DiagnoseServiceToolOutput = Schema.Schema.Type<typeof DiagnoseServiceToolOutput>

export const ListMetricsToolOutput = Schema.Struct({
  tool: Schema.Literal("list_metrics"),
  summaryText: Schema.String,
  data: ListMetricsData,
})
export type ListMetricsToolOutput = Schema.Schema.Type<typeof ListMetricsToolOutput>

export const QueryDataToolOutput = Schema.Struct({
  tool: Schema.Literal("query_data"),
  summaryText: Schema.String,
  data: QueryDataData,
})
export type QueryDataToolOutput = Schema.Schema.Type<typeof QueryDataToolOutput>

export const StructuredToolOutput = Schema.Union([
  SystemHealthToolOutput,
  ServiceOverviewToolOutput,
  SearchTracesToolOutput,
  FindSlowTracesToolOutput,
  FindErrorsToolOutput,
  ErrorDetailToolOutput,
  InspectTraceToolOutput,
  SearchLogsToolOutput,
  DiagnoseServiceToolOutput,
  ListMetricsToolOutput,
  QueryDataToolOutput,
])
export type StructuredToolOutput = Schema.Schema.Type<typeof StructuredToolOutput>
