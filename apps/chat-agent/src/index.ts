import { AIChatAgent } from "@cloudflare/ai-chat"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createMCPClient } from "@ai-sdk/mcp"
import { convertToModelMessages, streamText, stepCountIs, tool, createUIMessageStream, createUIMessageStreamResponse, type StreamTextOnFinishCallback, type ToolSet } from "ai"
import { routeAgentRequest } from "agents"
import { z } from "zod"
import type { Env } from "./lib/types"
import { SYSTEM_PROMPT, DASHBOARD_BUILDER_SYSTEM_PROMPT } from "./lib/system-prompt"

interface DashboardContext {
  dashboardName: string
  existingWidgets: Array<{ title: string; visualization: string }>
}

const METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
const METRIC_TYPES_SET = new Set<string>(METRIC_TYPES)
const QUERY_SOURCES = ["traces", "logs", "metrics"] as const
const QUERY_SOURCES_SET = new Set<string>(QUERY_SOURCES)
const QUERY_BUILDER_CHART_IDS = ["query-builder-bar", "query-builder-area", "query-builder-line"] as const

const widgetDisplaySchema = z.object({
  title: z.string().trim().min(1).describe("Widget title shown in the dashboard header"),
  unit: z
    .enum(["none", "number", "percent", "duration_ms", "duration_us", "duration_s", "duration_ns", "bytes", "requests_per_sec", "short"])
    .optional(),
  chartId: z.enum(QUERY_BUILDER_CHART_IDS).optional(),
  columns: z
    .array(
      z.object({
        field: z.string(),
        header: z.string(),
        unit: z.string().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
      }),
    )
    .optional(),
  listDataSource: z.enum(["traces", "logs"]).optional().describe("Data source for list visualization"),
  listLimit: z.number().min(1).max(50).optional().describe("Max items in list visualization"),
  listWhereClause: z.string().optional().describe("Filter for list visualization"),
  listRootOnly: z.boolean().optional().describe("Only root spans for trace lists"),
})

const dashboardWidgetDataSourceSchema = z.object({
  endpoint: z.string().describe("One of the available DataSourceEndpoint values"),
  params: z.record(z.string(), z.unknown()).optional(),
  transform: z.object({
    reduceToValue: z.object({
      field: z.string(),
      aggregate: z.enum(["sum", "first", "count", "avg", "max", "min"]),
    }).optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
    flattenSeries: z.object({ valueField: z.string() }).optional(),
    limit: z.number().optional(),
    sortBy: z.object({
      field: z.string(),
      direction: z.enum(["asc", "desc"]),
    }).optional(),
  }).optional(),
}).superRefine((dataSource, ctx) => {
  if (dataSource.endpoint !== "custom_query_builder_timeseries") {
    return
  }

  const params = dataSource.params
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "custom_query_builder_timeseries requires params.queries[]",
      path: ["params"],
    })
    return
  }

  const rawQueries = (params as Record<string, unknown>).queries
  if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "custom_query_builder_timeseries requires params.queries[]",
      path: ["params", "queries"],
    })
    return
  }

  for (const [index, rawQuery] of rawQueries.entries()) {
    if (typeof rawQuery !== "object" || rawQuery === null || Array.isArray(rawQuery)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each query must be an object",
        path: ["params", "queries", index],
      })
      continue
    }

    const query = rawQuery as Record<string, unknown>
    const querySource = query.dataSource ?? query.source
    if (
      typeof querySource !== "string" ||
      !QUERY_SOURCES_SET.has(querySource)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each query must provide dataSource or source in traces|logs|metrics",
        path: ["params", "queries", index, "dataSource"],
      })
      continue
    }

    if (querySource !== "metrics") continue

    if (typeof query.metricName !== "string" || query.metricName.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Metrics queries require metricName",
        path: ["params", "queries", index, "metricName"],
      })
    }

    if (
      typeof query.metricType !== "string" ||
      !METRIC_TYPES_SET.has(query.metricType)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Metrics queries require a valid metricType",
        path: ["params", "queries", index, "metricType"],
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Endpoint → MCP tool mapping for test_widget_query
// ---------------------------------------------------------------------------

const GROUP_BY_TOKEN_MAP: Record<string, string> = {
  "service.name": "service",
  "span.name": "span_name",
  "status.code": "status_code",
  "http.method": "http_method",
}

interface EndpointMapping {
  mcpTool: string
  mapParams: (params: Record<string, unknown>) => Record<string, unknown>
}

const ENDPOINT_MCP_MAP: Record<string, EndpointMapping> = {
  service_usage: {
    mcpTool: "service_overview",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
    }),
  },
  service_overview: {
    mcpTool: "service_overview",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
    }),
  },
  errors_summary: {
    mcpTool: "find_errors",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: (Array.isArray(p.services) ? p.services[0] : undefined) ?? p.service,
    }),
  },
  errors_by_type: {
    mcpTool: "find_errors",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: (Array.isArray(p.services) ? p.services[0] : undefined) ?? p.service,
      limit: p.limit,
    }),
  },
  list_traces: {
    mcpTool: "search_traces",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: p.service,
      limit: p.limit ?? 5,
    }),
  },
  list_logs: {
    mcpTool: "search_logs",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: p.service,
      severity: p.severity ?? p.minSeverity,
      limit: p.limit ?? 5,
    }),
  },
  list_metrics: {
    mcpTool: "list_metrics",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: p.service,
    }),
  },
  metrics_summary: {
    mcpTool: "list_metrics",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
      service: p.service,
    }),
  },
  error_rate_by_service: {
    mcpTool: "find_errors",
    mapParams: (p) => ({
      start_time: p.startTime ?? p.start_time,
      end_time: p.endTime ?? p.end_time,
    }),
  },
}

function mapQueryDraftToQueryDataParams(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const source = (query.dataSource ?? query.source) as string
  const rawGroupBy = Array.isArray(query.groupBy)
    ? query.groupBy.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "none"
    : typeof query.groupBy === "string" && query.groupBy.trim().length > 0
      ? query.groupBy
      : "none"
  const groupBy = GROUP_BY_TOKEN_MAP[rawGroupBy] ?? rawGroupBy

  const params: Record<string, unknown> = {
    source,
    kind: "timeseries",
    group_by: groupBy === "none" ? "none" : groupBy,
  }

  if (source === "traces") {
    params.metric = query.aggregation ?? "count"
  } else if (source === "logs") {
    params.metric = "count"
  } else if (source === "metrics") {
    params.metric = query.aggregation ?? "avg"
    params.metric_name = query.metricName
    params.metric_type = query.metricType
  }

  // Parse simple whereClause filters
  const whereClause = query.whereClause as string | undefined
  if (whereClause) {
    for (const match of whereClause.matchAll(/(\w[\w.]*)\s*=\s*['"]([^'"]+)['"]/g)) {
      const key = match[1]!.toLowerCase()
      const value = match[2]!
      if (key === "service" || key === "service.name") params.service_name = value
      else if (key === "span" || key === "span.name") params.span_name = value
      else if (key === "severity") params.severity = value
    }
  }

  return params
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpToolSet = Record<string, { execute: (...args: any[]) => Promise<unknown> }>

function callMcpTool(mcpTools: McpToolSet, toolName: string, params: Record<string, unknown>): Promise<unknown> {
  const mcpTool = mcpTools[toolName]
  if (!mcpTool) return Promise.resolve({ error: `MCP tool "${toolName}" not available` })
  // Strip undefined values from params
  const cleanParams: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) cleanParams[k] = v
  }
  return mcpTool.execute(cleanParams)
}

// ---------------------------------------------------------------------------
// Dashboard builder tools factory
// ---------------------------------------------------------------------------

function createDashboardBuilderTools(mcpTools: McpToolSet) {
  return {
    test_widget_query: tool({
      description:
        "Test a dashboard widget query before adding it. Runs the query the widget would use via MCP tools and returns the results so you can verify data exists and makes sense. ALWAYS call this before add_dashboard_widget.",
      inputSchema: z.object({
        endpoint: z.string().describe(
          "Widget data source endpoint (e.g., 'service_usage', 'errors_summary', 'custom_query_builder_timeseries')",
        ),
        params: z.record(z.string(), z.unknown()).optional().describe(
          "Parameters for the query (startTime, endTime, limit, queries[], etc.)",
        ),
        transform: z.object({
          reduceToValue: z.object({
            field: z.string(),
            aggregate: z.enum(["sum", "first", "count", "avg", "max", "min"]),
          }).optional(),
          limit: z.number().optional(),
        }).optional().describe(
          "Transform config to preview what the widget would display",
        ),
      }),
      execute: async ({ endpoint, params: rawParams, transform }) => {
        const p = rawParams ?? {}

        // --- custom_query_builder_timeseries: test each query via query_data ---
        if (endpoint === "custom_query_builder_timeseries") {
          const queries = p.queries as Record<string, unknown>[] | undefined
          if (!Array.isArray(queries) || queries.length === 0) {
            return { error: "custom_query_builder_timeseries requires params.queries[]" }
          }

          const enabledQueries = queries.filter((q) => q.enabled !== false)
          const results: string[] = [`Testing ${enabledQueries.length} query builder queries...`, ""]

          let anyData = false
          for (const query of enabledQueries) {
            const label = (query.name ?? "?") as string
            const queryDataParams = {
              ...mapQueryDraftToQueryDataParams(query),
              start_time: p.startTime ?? p.start_time,
              end_time: p.endTime ?? p.end_time,
            }

            try {
              const result = await callMcpTool(mcpTools, "query_data", queryDataParams)
              const resultStr = typeof result === "string" ? result : JSON.stringify(result)

              if (resultStr.includes("No data") || resultStr.includes("no data")) {
                results.push(`Query "${label}": EMPTY — no data returned`)
              } else {
                anyData = true
                results.push(`Query "${label}": OK — data found`)
                // Include a truncated preview of the result
                const preview = resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr
                results.push(preview)
              }
            } catch (error) {
              results.push(`Query "${label}": ERROR — ${error instanceof Error ? error.message : String(error)}`)
            }
            results.push("")
          }

          results.push(anyData
            ? "Widget query validated — data exists."
            : "WARNING: No data for any query. The widget would show empty.")

          return { status: "tested", summary: results.join("\n") }
        }

        // --- Pipe-backed endpoints: map to MCP tool ---
        const mapping = ENDPOINT_MCP_MAP[endpoint]
        if (!mapping) {
          return {
            error: `Unknown endpoint "${endpoint}". Known endpoints: ${Object.keys(ENDPOINT_MCP_MAP).join(", ")}, custom_query_builder_timeseries`,
          }
        }

        try {
          const mappedParams = mapping.mapParams(p)
          const result = await callMcpTool(mcpTools, mapping.mcpTool, mappedParams)
          const resultStr = typeof result === "string" ? result : JSON.stringify(result)
          const isEmpty = resultStr.includes("No ") && (resultStr.includes("found") || resultStr.includes("data"))

          const lines: string[] = [
            `Testing endpoint="${endpoint}" via MCP tool "${mapping.mcpTool}"...`,
            "",
          ]

          // Include truncated result
          const preview = resultStr.length > 800 ? resultStr.slice(0, 800) + "..." : resultStr
          lines.push(preview)

          // Apply transform preview
          if (transform?.reduceToValue) {
            lines.push("", `Transform: reduceToValue(field="${transform.reduceToValue.field}", aggregate="${transform.reduceToValue.aggregate}")`)
            lines.push("Note: The actual value will be computed from the widget's data. Check that the field name appears in the results above.")
          }

          lines.push(
            "",
            isEmpty
              ? "WARNING: Query returned no data. The widget would show empty."
              : "Widget query validated — data exists.",
          )

          return { status: "tested", summary: lines.join("\n") }
        } catch (error) {
          return {
            status: "error",
            summary: `Failed to test endpoint="${endpoint}": ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    }),
    add_dashboard_widget: tool({
      description:
        "Add a widget to the user's dashboard. IMPORTANT: You must first call test_widget_query with the same endpoint/params/transform to verify the data exists BEFORE calling this tool. Titles must be specific and non-empty. For charts, use chartId from query-builder-area|query-builder-line|query-builder-bar.",
      inputSchema: z.object({
        visualization: z.enum(["stat", "chart", "table", "list"]),
        dataSource: dashboardWidgetDataSourceSchema,
        display: widgetDisplaySchema,
      }),
      execute: async () => ({
        status: "proposed",
      }),
    }),
    remove_dashboard_widget: tool({
      description: "Remove a widget from the dashboard by its title.",
      inputSchema: z.object({
        widgetTitle: z.string().describe("The title of the widget to remove"),
      }),
      execute: async () => ({
        status: "proposed",
      }),
    }),
  }
}

function createErrorResponse(errorMessage: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "error", errorText: errorMessage })
    },
  })
  return createUIMessageStreamResponse({ stream })
}

export { ChatAgent }

class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    const body = options?.body as Record<string, unknown> | undefined
    const orgId = body?.orgId as string | undefined
    if (!orgId) {
      return createErrorResponse("orgId is required in the request body")
    }

    const mode = (body?.mode as string) ?? "default"
    const dashboardContext = body?.dashboardContext as DashboardContext | undefined

    let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | undefined

    try {
      const mcpUrl = `${this.env.MAPLE_API_URL}/mcp`
      console.log(`[chat-agent] Connecting to MCP server at ${mcpUrl} for org ${orgId} (mode: ${mode})`)

      mcpClient = await createMCPClient({
        transport: {
          type: "http",
          url: mcpUrl,
          headers: {
            Authorization: `Bearer maple_svc_${this.env.INTERNAL_SERVICE_TOKEN}`,
            "X-Org-Id": orgId,
          },
        },
        onUncaughtError: (error) => {
          console.error("[chat-agent] MCP uncaught error:", error)
        },
      })

      const mcpTools = await mcpClient.tools()
      console.log(`[chat-agent] Loaded ${Object.keys(mcpTools).length} tools from MCP server`)

      const isDashboardMode = mode === "dashboard_builder"

      let systemPrompt = isDashboardMode ? DASHBOARD_BUILDER_SYSTEM_PROMPT : SYSTEM_PROMPT
      if (isDashboardMode && dashboardContext) {
        const widgetList = dashboardContext.existingWidgets.length > 0
          ? dashboardContext.existingWidgets.map((w) => `- "${w.title}" (${w.visualization})`).join("\n")
          : "(none)"
        systemPrompt += `\n\n## Current Dashboard Context\nDashboard: "${dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
      }

      const allTools = isDashboardMode
        ? { ...mcpTools, ...createDashboardBuilderTools(mcpTools as unknown as McpToolSet) }
        : mcpTools

      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: this.env.OPENROUTER_API_KEY,
      })

      const result = streamText({
        model: openrouter.chatModel("moonshotai/kimi-k2.5:nitro"),
        system: systemPrompt,
        messages: await convertToModelMessages(this.messages),
        tools: allTools as ToolSet,
        stopWhen: stepCountIs(20),
        abortSignal: options?.abortSignal,
        onFinish: async (event) => {
          await mcpClient?.close()
          await (onFinish as unknown as StreamTextOnFinishCallback<ToolSet>)(event)
        },
      })

      return result.toUIMessageStreamResponse()
    } catch (error) {
      if (mcpClient) {
        try { await mcpClient.close() } catch { /* ignore cleanup errors */ }
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error("[chat-agent] Error in onChatMessage:", errorMessage)

      return createErrorResponse(errorMessage)
    }
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    const response = await routeAgentRequest(request, env)
    if (response) {
      const newResponse = new Response(response.body, response)
      for (const [key, value] of Object.entries(corsHeaders)) {
        newResponse.headers.set(key, value)
      }
      return newResponse
    }

    return new Response("Not Found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
