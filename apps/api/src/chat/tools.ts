import { Tool, Toolkit } from "effect/unstable/ai"
import { Effect, Schema } from "effect"
import { collectToolDefinitions, type ToolDefinition } from "@/mcp/server"
import type { McpToolResult } from "@/mcp/tools/types"

// ---------- Observability tool definitions (matching MCP tools) ----------

const SystemHealth = Tool.make("system_health", {
  description: "Get an overall health snapshot of the system: error rate, active services, latency stats, and top errors.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
  }),
  success: Schema.String,
})

const FindErrors = Tool.make("find_errors", {
  description: "Find and categorize errors by type, with counts, affected services, and timestamps.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const InspectTrace = Tool.make("inspect_trace", {
  description: "Deep-dive into a trace: shows the full span tree with durations and status, plus correlated logs.",
  parameters: Schema.Struct({
    trace_id: Schema.String,
  }),
  success: Schema.String,
})

const SearchLogs = Tool.make("search_logs", {
  description: "Search and filter logs by service, severity, time range, or body text.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    severity: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
    trace_id: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const SearchTraces = Tool.make("search_traces", {
  description: "Search and filter traces by service, duration, error status, HTTP method, and more.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    has_error: Schema.optional(Schema.Boolean),
    min_duration_ms: Schema.optional(Schema.Number),
    max_duration_ms: Schema.optional(Schema.Number),
    http_method: Schema.optional(Schema.String),
    span_name: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const ServiceOverview = Tool.make("service_overview", {
  description: "List all services with health metrics: latency (P50/P95/P99), error rate, and throughput.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
  }),
  success: Schema.String,
})

const DiagnoseService = Tool.make("diagnose_service", {
  description: "Deep investigation of a single service: health metrics, top errors, recent logs, slow traces, and Apdex score.",
  parameters: Schema.Struct({
    service_name: Schema.String,
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
  }),
  success: Schema.String,
})

const FindSlowTraces = Tool.make("find_slow_traces", {
  description: "Find the slowest traces with percentile context (P50, P95 benchmarks).",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const ErrorDetail = Tool.make("error_detail", {
  description: "Investigate a specific error type: shows sample traces with their metadata and correlated logs.",
  parameters: Schema.Struct({
    error_type: Schema.String,
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const ListMetrics = Tool.make("list_metrics", {
  description: "Discover available metrics with type, service, description, and data point counts.",
  parameters: Schema.Struct({
    start_time: Schema.optional(Schema.String),
    end_time: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
    metric_type: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.String,
})

const QueryData = Tool.make("query_data", {
  description: "Execute a structured observability query with only supported combinations. Supported queries: traces timeseries, traces breakdown, logs timeseries, logs breakdown, metrics timeseries, and metrics breakdown.",
  parameters: Schema.Struct({
    source: Schema.Literals(["traces", "logs", "metrics"] as const),
    kind: Schema.Literals(["timeseries", "breakdown"] as const),
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
  }),
  success: Schema.String,
})

// ---------- Dashboard builder tools ----------

const AddDashboardWidget = Tool.make("add_dashboard_widget", {
  description: "Add a widget to the user's dashboard. The widget will be previewed and the user can confirm adding it.",
  parameters: Schema.Struct({
    visualization: Schema.Literals(["stat", "chart", "table"] as const),
    dataSource: Schema.Unknown,
    display: Schema.Unknown,
  }),
  success: Schema.Unknown,
})

const RemoveDashboardWidget = Tool.make("remove_dashboard_widget", {
  description: "Remove a widget from the dashboard by its title.",
  parameters: Schema.Struct({
    widgetTitle: Schema.String,
  }),
  success: Schema.Unknown,
})

// ---------- Toolkit ----------

export const ObservabilityToolkit = Toolkit.make(
  SystemHealth,
  FindErrors,
  InspectTrace,
  SearchLogs,
  SearchTraces,
  ServiceOverview,
  DiagnoseService,
  FindSlowTraces,
  ErrorDetail,
  ListMetrics,
  QueryData,
)

export const DashboardToolkit = Toolkit.merge(
  ObservabilityToolkit,
  Toolkit.make(AddDashboardWidget, RemoveDashboardWidget),
)

// ---------- Handler builders ----------

const extractText = (result: McpToolResult): string =>
  result.content.map((c) => c.text).join("\n")

/**
 * Build a handler map that delegates to the existing MCP tool handlers.
 * The MCP handlers are identified by name from `collectToolDefinitions()`.
 */
export const buildMcpHandlers = () => {
  const definitions = collectToolDefinitions()
  const byName = new Map<string, ToolDefinition>()
  for (const def of definitions) {
    byName.set(def.name, def)
  }

  const callMcpTool = (name: string, params: unknown) => {
    const def = byName.get(name)
    if (!def) return Effect.succeed(`Unknown tool: ${name}`)

    return def.handler(params).pipe(
      Effect.map(extractText),
      Effect.catch(() =>
        Effect.succeed("Error executing tool"),
      ),
    )
  }

  return {
    system_health: (params: any) => callMcpTool("system_health", params),
    find_errors: (params: any) => callMcpTool("find_errors", params),
    inspect_trace: (params: any) => callMcpTool("inspect_trace", params),
    search_logs: (params: any) => callMcpTool("search_logs", params),
    search_traces: (params: any) => callMcpTool("search_traces", params),
    service_overview: (params: any) => callMcpTool("service_overview", params),
    diagnose_service: (params: any) => callMcpTool("diagnose_service", params),
    find_slow_traces: (params: any) => callMcpTool("find_slow_traces", params),
    error_detail: (params: any) => callMcpTool("error_detail", params),
    list_metrics: (params: any) => callMcpTool("list_metrics", params),
    query_data: (params: any) => callMcpTool("query_data", params),
  }
}

const dashboardHandlers = {
  add_dashboard_widget: () => Effect.succeed({ status: "proposed" }),
  remove_dashboard_widget: () => Effect.succeed({ status: "proposed" }),
}

/** Build the observability toolkit with handlers bound */
export const buildObservabilityToolkit = () =>
  Effect.gen(function* () {
    return yield* ObservabilityToolkit
  }).pipe(Effect.provide(ObservabilityToolkit.toLayer(buildMcpHandlers() as any)))

/** Build the dashboard toolkit with handlers bound (observability + dashboard tools) */
export const buildDashboardToolkit = () =>
  Effect.gen(function* () {
    return yield* DashboardToolkit
  }).pipe(
    Effect.provide(
      DashboardToolkit.toLayer({
        ...buildMcpHandlers(),
        ...dashboardHandlers,
      } as any),
    ),
  )
