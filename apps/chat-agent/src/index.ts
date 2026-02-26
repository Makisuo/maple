import { AIChatAgent } from "@cloudflare/ai-chat"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createMCPClient } from "@ai-sdk/mcp"
import { convertToModelMessages, streamText, stepCountIs, type StreamTextOnFinishCallback } from "ai"
import { routeAgentRequest } from "agents"
import type { Env } from "./lib/types"
import { SYSTEM_PROMPT } from "./lib/system-prompt"

export { ChatAgent }

class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    const orgId = (options?.body as Record<string, unknown>)?.orgId as string | undefined
    if (!orgId) {
      throw new Error("orgId is required in the request body")
    }

    const mcpUrl = `${this.env.MAPLE_API_URL}/mcp`
    console.log(`[chat-agent] Connecting to MCP server at ${mcpUrl} for org ${orgId}`)

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

    let tools: Awaited<ReturnType<typeof mcpClient.tools>>
    try {
      tools = await mcpClient.tools()
      console.log(`[chat-agent] Loaded ${Object.keys(tools).length} tools from MCP server`)
    } catch (error) {
      await mcpClient.close()
      console.error("[chat-agent] Error loading tools:", error)
      throw error
    }

    const openrouter = createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: this.env.OPENROUTER_API_KEY,
    })

    const result = streamText({
      model: openrouter.chatModel("moonshotai/kimi-k2.5:nitro"),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(10),
      onFinish: async (event) => {
        await mcpClient.close()
        ;(onFinish as unknown as StreamTextOnFinishCallback<typeof tools>)(event)
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
