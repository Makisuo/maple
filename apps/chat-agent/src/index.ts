import { AIChatAgent } from "@cloudflare/ai-chat"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createMCPClient } from "@ai-sdk/mcp"
import { convertToModelMessages, streamText, stepCountIs, tool, type StreamTextOnFinishCallback } from "ai"
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
    if (query.dataSource !== "metrics") continue

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

const dashboardBuilderTools = {
  add_dashboard_widget: tool({
    description: "Add a widget to the user's dashboard. The widget will be previewed and the user can confirm adding it.",
    inputSchema: z.object({
      visualization: z.enum(["stat", "chart", "table"]),
      dataSource: dashboardWidgetDataSourceSchema,
      display: z.object({
        title: z.string(),
        unit: z.enum(["none", "number", "percent", "duration_ms", "duration_us", "bytes", "requests_per_sec", "short"]).optional(),
        chartId: z.string().optional(),
        columns: z.array(z.object({
          field: z.string(),
          header: z.string(),
          unit: z.string().optional(),
          align: z.enum(["left", "center", "right"]).optional(),
        })).optional(),
      }),
    }),
  }),
  remove_dashboard_widget: tool({
    description: "Remove a widget from the dashboard by its title.",
    inputSchema: z.object({
      widgetTitle: z.string().describe("The title of the widget to remove"),
    }),
  }),
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
      throw new Error("orgId is required in the request body")
    }

    const mode = (body?.mode as string) ?? "default"
    const dashboardContext = body?.dashboardContext as DashboardContext | undefined

    const mcpUrl = `${this.env.MAPLE_API_URL}/mcp`
    console.log(`[chat-agent] Connecting to MCP server at ${mcpUrl} for org ${orgId} (mode: ${mode})`)

    const mcpClient = await createMCPClient({
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

    let mcpTools: Awaited<ReturnType<typeof mcpClient.tools>>
    try {
      mcpTools = await mcpClient.tools()
      console.log(`[chat-agent] Loaded ${Object.keys(mcpTools).length} tools from MCP server`)
    } catch (error) {
      await mcpClient.close()
      console.error("[chat-agent] Error loading tools:", error)
      throw error
    }

    const isDashboardMode = mode === "dashboard_builder"

    let systemPrompt = isDashboardMode ? DASHBOARD_BUILDER_SYSTEM_PROMPT : SYSTEM_PROMPT
    if (isDashboardMode && dashboardContext) {
      const widgetList = dashboardContext.existingWidgets.length > 0
        ? dashboardContext.existingWidgets.map((w) => `- "${w.title}" (${w.visualization})`).join("\n")
        : "(none)"
      systemPrompt += `\n\n## Current Dashboard Context\nDashboard: "${dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
    }

    const allTools = isDashboardMode
      ? { ...mcpTools, ...dashboardBuilderTools }
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
      tools: allTools,
      stopWhen: stepCountIs(10),
      onFinish: async (event) => {
        await mcpClient.close()
        ;(onFinish as unknown as StreamTextOnFinishCallback<typeof allTools>)(event)
      },
    })

    return result.toUIMessageStreamResponse()
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
