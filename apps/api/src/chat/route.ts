import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { AuthService } from "@/services/AuthService"
import { Env } from "@/services/Env"
import { SYSTEM_PROMPT, DASHBOARD_BUILDER_SYSTEM_PROMPT } from "./system-prompt"
import { buildObservabilityToolkit, buildDashboardToolkit } from "./tools"
import { streamAgentLoop } from "./agent-loop"
import { effectStreamToResponse } from "./stream-bridge"
import { makeOpenRouterModel } from "./openrouter"

interface ChatRequestBody {
  messages: Array<{
    role: "user" | "assistant" | "system"
    parts?: Array<{ type: string; text?: string; [key: string]: unknown }>
    content?: string
  }>
  mode?: string
  dashboardContext?: {
    dashboardName: string
    existingWidgets: Array<{ title: string; visualization: string }>
  }
}

const extractMessages = (body: ChatRequestBody): Prompt.RawInput => {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = []

  const isDashboardMode = body.mode === "dashboard_builder"
  let systemPrompt = isDashboardMode ? DASHBOARD_BUILDER_SYSTEM_PROMPT : SYSTEM_PROMPT

  if (isDashboardMode && body.dashboardContext) {
    const widgetList = body.dashboardContext.existingWidgets.length > 0
      ? body.dashboardContext.existingWidgets.map((w) => `- "${w.title}" (${w.visualization})`).join("\n")
      : "(none)"
    systemPrompt += `\n\n## Current Dashboard Context\nDashboard: "${body.dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
  }

  messages.push({ role: "system", content: systemPrompt })

  for (const msg of body.messages) {
    const role = msg.role === "system" ? "user" : msg.role
    let content = ""

    if (msg.parts) {
      // UIMessage format with parts array
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          content += part.text
        }
      }
    } else if (msg.content) {
      content = msg.content
    }

    if (content.trim()) {
      messages.push({ role, content })
    }
  }

  return messages
}

export const ChatRouter = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const env = yield* Env
    const authService = yield* AuthService

    const openrouterKey = Option.match(env.OPENROUTER_API_KEY, {
      onNone: () => undefined,
      onSome: (value) => Redacted.value(value),
    })

    if (!openrouterKey) {
      yield* Effect.logWarning("OPENROUTER_API_KEY not configured — /api/chat endpoint disabled")
      return
    }

    yield* router.add("POST", "/api/chat", (req) =>
      Effect.gen(function* () {
        // Authenticate the request
        const tenant = yield* authService.resolveTenant(
          req.headers as Record<string, string>,
        )

        // Parse request body
        const body = (yield* req.json) as unknown as ChatRequestBody

        if (!body.messages || !Array.isArray(body.messages)) {
          return yield* HttpServerResponse.json(
            { error: "messages array is required" },
            { status: 400 },
          )
        }

        // Build the prompt from messages
        const prompt = extractMessages(body)

        // Build toolkit based on mode
        const isDashboardMode = body.mode === "dashboard_builder"
        const toolkit = yield* (isDashboardMode
          ? buildDashboardToolkit()
          : buildObservabilityToolkit()
        )

        // Create a synthetic HttpServerRequest so MCP tool handlers can resolve the tenant
        // The existing queryTinybird() reads HttpServerRequest to get auth headers
        const syntheticHeaders = new Headers()
        const authHeader = (req.headers as Record<string, string>)["authorization"]
        if (authHeader) syntheticHeaders.set("authorization", authHeader)
        syntheticHeaders.set("x-org-id", tenant.orgId)

        const syntheticWebRequest = new Request("http://localhost/mcp", {
          method: "POST",
          headers: syntheticHeaders,
        })
        const syntheticRequest = HttpServerRequest.fromWeb(syntheticWebRequest)

        // Create the model
        const model = yield* makeOpenRouterModel("moonshotai/kimi-k2.5:nitro")

        // Run agent loop with all services provided, collecting into a fully resolved stream
        const agentStream = streamAgentLoop({ prompt, toolkit })

        // Provide LanguageModel and HttpServerRequest to the stream,
        // then convert all dependencies to `never` so effectStreamToResponse can run it
        const resolvedStream = agentStream.pipe(
          Stream.provideService(LanguageModel.LanguageModel, model),
          Stream.provideService(HttpServerRequest.HttpServerRequest, syntheticRequest),
        ) as Stream.Stream<import("effect/unstable/ai").Response.AnyPart, unknown, never>

        // Bridge to Vercel AI SDK response
        const response = effectStreamToResponse(resolvedStream)

        // Pass the ReadableStream body directly to Bun's HTTP server
        return HttpServerResponse.raw(response.body, {
          status: response.status,
          contentType: response.headers.get("content-type") ?? undefined,
          headers: {
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        })
      }),
    )
  }),
)
