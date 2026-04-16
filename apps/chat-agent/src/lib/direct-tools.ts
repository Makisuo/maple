import { jsonSchema, tool, type ToolSet } from "ai"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { getMapleAgentRuntime, mapleToolDefinitions, toInputSchema } from "@maple/api/agent"

const createInternalToolRequest = (
  orgId: string,
  internalServiceToken: string,
) =>
  new Request("https://maple-chat-agent.internal/mcp", {
    headers: {
      Authorization: `Bearer maple_svc_${internalServiceToken}`,
      "X-Org-Id": orgId,
    },
  })

export const createMapleAiTools = (
  env: Record<string, unknown>,
  orgId: string,
): ToolSet => {
  const runtime = getMapleAgentRuntime(env)
  const requestLayer = Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(
      createInternalToolRequest(orgId, String(env.INTERNAL_SERVICE_TOKEN ?? "")),
    ),
  )

  return Object.fromEntries(
    mapleToolDefinitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(toInputSchema(definition.schema) as any),
        execute: async (input) => {
          try {
            const decoded = Schema.decodeUnknownSync(definition.schema)(input)
            return await runtime.runPromise(
              definition.handler(decoded).pipe(Effect.provide(requestLayer)),
            )
          } catch (error) {
            const message = Schema.isSchemaError(error)
              ? `Invalid parameters: ${String(error)}`
              : error instanceof Error
                ? error.message
                : String(error)
            return {
              isError: true,
              content: [{ type: "text" as const, text: message }],
            }
          }
        },
      }),
    ]),
  )
}
