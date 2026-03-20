import { Schema } from "effect"
import {
  DiagnoseServiceToolOutput,
  ErrorDetailToolOutput,
  FindErrorsToolOutput,
  FindSlowTracesToolOutput,
  InspectTraceToolOutput,
  ListMetricsToolOutput,
  QueryDataToolOutput,
  SearchLogsToolOutput,
  SearchTracesToolOutput,
  ServiceOverviewToolOutput,
  StructuredToolOutput,
  SystemHealthToolOutput,
} from "./mcp-structured-types"

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export const ChatMode = Schema.Literals(["default", "dashboard_builder"])
export type ChatMode = Schema.Schema.Type<typeof ChatMode>

export const ChatMessageRole = Schema.Literals(["user", "assistant", "system"])
export type ChatMessageRole = Schema.Schema.Type<typeof ChatMessageRole>

export const RawChatMessagePart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
})
export type RawChatMessagePart = Schema.Schema.Type<typeof RawChatMessagePart>

export const RawChatMessage = Schema.Struct({
  role: ChatMessageRole,
  parts: Schema.optional(Schema.Array(RawChatMessagePart)),
  content: Schema.optional(Schema.String),
})
export type RawChatMessage = Schema.Schema.Type<typeof RawChatMessage>

export const NormalizedChatTextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
export type NormalizedChatTextPart = Schema.Schema.Type<typeof NormalizedChatTextPart>

export const NormalizedChatMessage = Schema.Struct({
  role: ChatMessageRole,
  parts: Schema.Array(NormalizedChatTextPart),
})
export type NormalizedChatMessage = Schema.Schema.Type<typeof NormalizedChatMessage>

export const ChatDashboardWidgetSummary = Schema.Struct({
  title: Schema.String,
  visualization: Schema.String,
})
export type ChatDashboardWidgetSummary = Schema.Schema.Type<typeof ChatDashboardWidgetSummary>

export const ChatDashboardContext = Schema.Struct({
  dashboardName: Schema.String,
  existingWidgets: Schema.Array(ChatDashboardWidgetSummary),
})
export type ChatDashboardContext = Schema.Schema.Type<typeof ChatDashboardContext>

export const ChatRequest = Schema.Struct({
  messages: Schema.Array(RawChatMessage),
  mode: Schema.optional(ChatMode),
  dashboardContext: Schema.optional(ChatDashboardContext),
})
export type ChatRequest = Schema.Schema.Type<typeof ChatRequest>

export const NormalizedChatRequest = Schema.Struct({
  messages: Schema.Array(NormalizedChatMessage),
  mode: ChatMode,
  dashboardContext: Schema.optional(ChatDashboardContext),
})
export type NormalizedChatRequest = Schema.Schema.Type<typeof NormalizedChatRequest>

export const DataSourceEndpoint = Schema.Literals([
  "service_usage",
  "service_overview",
  "service_overview_time_series",
  "service_apdex_time_series",
  "services_facets",
  "list_traces",
  "traces_facets",
  "traces_duration_stats",
  "list_logs",
  "logs_count",
  "logs_facets",
  "errors_summary",
  "errors_by_type",
  "error_detail_traces",
  "errors_facets",
  "error_rate_by_service",
  "list_metrics",
  "metrics_summary",
  "metric_time_series_sum",
  "metric_time_series_gauge",
  "metric_time_series_histogram",
  "metric_time_series_exp_histogram",
  "custom_timeseries",
  "custom_breakdown",
  "custom_query_builder_timeseries",
])
export type DataSourceEndpoint = Schema.Schema.Type<typeof DataSourceEndpoint>

export const WidgetDataSourceTransform = Schema.Struct({
  fieldMap: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  flattenSeries: Schema.optional(
    Schema.Struct({
      valueField: Schema.String,
    }),
  ),
  reduceToValue: Schema.optional(
    Schema.Struct({
      field: Schema.String,
      aggregate: Schema.optional(
        Schema.Literals(["sum", "first", "count", "avg", "max", "min"]),
      ),
    }),
  ),
  computeRatio: Schema.optional(
    Schema.Struct({
      numeratorName: Schema.String,
      denominatorNames: Schema.Array(Schema.String),
    }),
  ),
  limit: Schema.optional(Schema.Number),
  sortBy: Schema.optional(
    Schema.Struct({
      field: Schema.String,
      direction: Schema.Literals(["asc", "desc"]),
    }),
  ),
})
export type WidgetDataSourceTransform = Schema.Schema.Type<typeof WidgetDataSourceTransform>

export const WidgetDataSource = Schema.Struct({
  endpoint: DataSourceEndpoint,
  params: Schema.optional(UnknownRecord),
  transform: Schema.optional(WidgetDataSourceTransform),
})
export type WidgetDataSource = Schema.Schema.Type<typeof WidgetDataSource>

export const WidgetDisplayColumn = Schema.Struct({
  field: Schema.String,
  header: Schema.String,
  unit: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  align: Schema.optional(Schema.Literals(["left", "center", "right"])),
})
export type WidgetDisplayColumn = Schema.Schema.Type<typeof WidgetDisplayColumn>

export const WidgetDisplayConfig = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  chartId: Schema.optional(Schema.String),
  chartPresentation: Schema.optional(
    Schema.Struct({
      legend: Schema.optional(Schema.Literals(["visible", "hidden"])),
      tooltip: Schema.optional(Schema.Literals(["visible", "hidden"])),
    }),
  ),
  xAxis: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      unit: Schema.optional(Schema.String),
      visible: Schema.optional(Schema.Boolean),
    }),
  ),
  yAxis: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      unit: Schema.optional(Schema.String),
      min: Schema.optional(Schema.Number),
      max: Schema.optional(Schema.Number),
      visible: Schema.optional(Schema.Boolean),
    }),
  ),
  seriesMapping: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  colorOverrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  stacked: Schema.optional(Schema.Boolean),
  unit: Schema.optional(Schema.String),
  thresholds: Schema.optional(
    Schema.Array(
      Schema.Struct({
        value: Schema.Number,
        color: Schema.String,
        label: Schema.optional(Schema.String),
      }),
    ),
  ),
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  sparkline: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      dataSource: Schema.optional(WidgetDataSource),
    }),
  ),
  columns: Schema.optional(Schema.Array(WidgetDisplayColumn)),
})
export type WidgetDisplayConfig = Schema.Schema.Type<typeof WidgetDisplayConfig>

export const DashboardWidgetProposal = Schema.Struct({
  visualization: Schema.Literals(["stat", "chart", "table"]),
  dataSource: WidgetDataSource,
  display: WidgetDisplayConfig,
})
export type DashboardWidgetProposal = Schema.Schema.Type<typeof DashboardWidgetProposal>

export const DashboardWidgetRemoval = Schema.Struct({
  widgetTitle: Schema.String,
})
export type DashboardWidgetRemoval = Schema.Schema.Type<typeof DashboardWidgetRemoval>

export const AddDashboardWidgetToolOutput = Schema.Struct({
  tool: Schema.Literal("add_dashboard_widget"),
  summaryText: Schema.String,
  data: DashboardWidgetProposal,
})
export type AddDashboardWidgetToolOutput = Schema.Schema.Type<typeof AddDashboardWidgetToolOutput>

export const RemoveDashboardWidgetToolOutput = Schema.Struct({
  tool: Schema.Literal("remove_dashboard_widget"),
  summaryText: Schema.String,
  data: DashboardWidgetRemoval,
})
export type RemoveDashboardWidgetToolOutput = Schema.Schema.Type<typeof RemoveDashboardWidgetToolOutput>

export const ChatToolResult = Schema.Union([
  StructuredToolOutput,
  AddDashboardWidgetToolOutput,
  RemoveDashboardWidgetToolOutput,
])
export type ChatToolResult = Schema.Schema.Type<typeof ChatToolResult>

export const CHAT_TOOL_NAMES = [
  "system_health",
  "find_errors",
  "inspect_trace",
  "search_logs",
  "search_traces",
  "service_overview",
  "diagnose_service",
  "find_slow_traces",
  "error_detail",
  "list_metrics",
  "query_data",
  "add_dashboard_widget",
  "remove_dashboard_widget",
] as const
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number]

export type ChatToolRenderKind =
  | "structured"
  | "dashboard_add_widget"
  | "dashboard_remove_widget"

export type ChatToolIcon =
  | "pulse"
  | "server"
  | "magnifier"
  | "warning"
  | "error"
  | "network"
  | "clock"
  | "database"
  | "chart"
  | "code"
  | "grid"
  | "trash"

export const SystemHealthToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
})

export const FindErrorsToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const InspectTraceToolInput = Schema.Struct({
  trace_id: Schema.String,
})

export const SearchLogsToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  trace_id: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const SearchTracesToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  has_error: Schema.optional(Schema.Boolean),
  min_duration_ms: Schema.optional(Schema.Number),
  max_duration_ms: Schema.optional(Schema.Number),
  http_method: Schema.optional(Schema.String),
  span_name: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const ServiceOverviewToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
})

export const DiagnoseServiceToolInput = Schema.Struct({
  service_name: Schema.String,
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
})

export const FindSlowTracesToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const ErrorDetailToolInput = Schema.Struct({
  error_type: Schema.String,
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const ListMetricsToolInput = Schema.Struct({
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
  metric_type: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const QueryDataToolInput = Schema.Struct({
  source: Schema.Literals(["traces", "logs", "metrics"]),
  kind: Schema.Literals(["timeseries", "breakdown"]),
  metric: Schema.optional(Schema.String),
  group_by: Schema.optional(Schema.String),
  bucket_seconds: Schema.optional(Schema.Number),
  series_limit: Schema.optional(Schema.Number),
  series_order: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  start_time: Schema.optional(Schema.String),
  end_time: Schema.optional(Schema.String),
  service_name: Schema.optional(Schema.String),
  span_name: Schema.optional(Schema.String),
  root_spans_only: Schema.optional(Schema.Boolean),
  environments: Schema.optional(Schema.String),
  commit_shas: Schema.optional(Schema.String),
  status_codes: Schema.optional(Schema.String),
  http_methods: Schema.optional(Schema.String),
  http_routes: Schema.optional(Schema.String),
  peer_services: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  metric_name: Schema.optional(Schema.String),
  metric_type: Schema.optional(Schema.String),
  attribute_key: Schema.optional(Schema.String),
  attribute_value: Schema.optional(Schema.String),
})

export const AddDashboardWidgetToolInput = DashboardWidgetProposal
export const RemoveDashboardWidgetToolInput = DashboardWidgetRemoval

export const chatToolMetadata = {
  system_health: {
    description:
      "Get an overall health snapshot of the system: error rate, active services, latency stats, and top errors.",
    label: "System Health",
    icon: "pulse",
    renderKind: "structured",
    inputSchema: SystemHealthToolInput,
    outputSchema: SystemHealthToolOutput,
  },
  find_errors: {
    description: "Find and categorize errors by type, with counts, affected services, and timestamps.",
    label: "Find Errors",
    icon: "error",
    renderKind: "structured",
    inputSchema: FindErrorsToolInput,
    outputSchema: FindErrorsToolOutput,
  },
  inspect_trace: {
    description:
      "Deep-dive into a trace: shows the full span tree with durations and status, plus correlated logs.",
    label: "Inspect Trace",
    icon: "magnifier",
    renderKind: "structured",
    inputSchema: InspectTraceToolInput,
    outputSchema: InspectTraceToolOutput,
  },
  search_logs: {
    description: "Search and filter logs by service, severity, time range, or body text.",
    label: "Search Logs",
    icon: "database",
    renderKind: "structured",
    inputSchema: SearchLogsToolInput,
    outputSchema: SearchLogsToolOutput,
  },
  search_traces: {
    description: "Search and filter traces by service, duration, error status, HTTP method, and more.",
    label: "Search Traces",
    icon: "network",
    renderKind: "structured",
    inputSchema: SearchTracesToolInput,
    outputSchema: SearchTracesToolOutput,
  },
  service_overview: {
    description: "List all services with health metrics: latency (P50/P95/P99), error rate, and throughput.",
    label: "Service Overview",
    icon: "server",
    renderKind: "structured",
    inputSchema: ServiceOverviewToolInput,
    outputSchema: ServiceOverviewToolOutput,
  },
  diagnose_service: {
    description:
      "Deep investigation of a single service: health metrics, top errors, recent logs, slow traces, and Apdex score.",
    label: "Diagnose Service",
    icon: "magnifier",
    renderKind: "structured",
    inputSchema: DiagnoseServiceToolInput,
    outputSchema: DiagnoseServiceToolOutput,
  },
  find_slow_traces: {
    description: "Find the slowest traces with percentile context (P50, P95 benchmarks).",
    label: "Find Slow Traces",
    icon: "clock",
    renderKind: "structured",
    inputSchema: FindSlowTracesToolInput,
    outputSchema: FindSlowTracesToolOutput,
  },
  error_detail: {
    description:
      "Investigate a specific error type: shows sample traces with their metadata and correlated logs.",
    label: "Error Detail",
    icon: "warning",
    renderKind: "structured",
    inputSchema: ErrorDetailToolInput,
    outputSchema: ErrorDetailToolOutput,
  },
  list_metrics: {
    description: "Discover available metrics with type, service, description, and data point counts.",
    label: "List Metrics",
    icon: "chart",
    renderKind: "structured",
    inputSchema: ListMetricsToolInput,
    outputSchema: ListMetricsToolOutput,
  },
  query_data: {
    description:
      "Execute a structured observability query with only supported combinations. Supported queries: traces timeseries, traces breakdown, logs timeseries, logs breakdown, metrics timeseries, and metrics breakdown.",
    label: "Query Data",
    icon: "code",
    renderKind: "structured",
    inputSchema: QueryDataToolInput,
    outputSchema: QueryDataToolOutput,
  },
  add_dashboard_widget: {
    description:
      "Add a widget to the user's dashboard. The widget will be previewed and the user can confirm adding it.",
    label: "Add Widget",
    icon: "grid",
    renderKind: "dashboard_add_widget",
    inputSchema: AddDashboardWidgetToolInput,
    outputSchema: AddDashboardWidgetToolOutput,
  },
  remove_dashboard_widget: {
    description: "Remove a widget from the dashboard by its title.",
    label: "Remove Widget",
    icon: "trash",
    renderKind: "dashboard_remove_widget",
    inputSchema: RemoveDashboardWidgetToolInput,
    outputSchema: RemoveDashboardWidgetToolOutput,
  },
} satisfies Record<
  ChatToolName,
  {
    readonly description: string
    readonly label: string
    readonly icon: ChatToolIcon
    readonly renderKind: ChatToolRenderKind
    readonly inputSchema: Schema.Top
    readonly outputSchema: Schema.Top
  }
>
