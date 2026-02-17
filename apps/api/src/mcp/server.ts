import { McpSchema, McpServer as EffectMcpServer } from "@effect/ai"
import { Effect, Layer } from "effect"
import * as JSONSchema from "effect/JSONSchema"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { registerSystemHealthTool } from "./tools/system-health"
import { registerFindErrorsTool } from "./tools/find-errors"
import { registerInspectTraceTool } from "./tools/inspect-trace"
import { registerSearchLogsTool } from "./tools/search-logs"
import { registerSearchTracesTool } from "./tools/search-traces"
import { registerServiceOverviewTool } from "./tools/service-overview"
import { registerDiagnoseServiceTool } from "./tools/diagnose-service"
import { registerFindSlowTracesTool } from "./tools/find-slow-traces"
import { registerErrorDetailTool } from "./tools/error-detail"
import { registerListMetricsTool } from "./tools/list-metrics"
import type { McpToolRegistrar, McpToolResult } from "./tools/types"

interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly schema: Schema.Struct.Fields
  readonly handler: (params: unknown) => Effect.Effect<McpToolResult>
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const toCallToolResult = (result: McpToolResult): typeof McpSchema.CallToolResult.Type =>
  new McpSchema.CallToolResult({
    isError: result.isError === true ? true : undefined,
    content: result.content.map((entry) => ({
      type: "text" as const,
      text: entry.text,
    })),
  })

const toInputSchema = (shape: Schema.Struct.Fields): Record<string, unknown> => {
  const { $schema, ...schema } = JSONSchema.make(Schema.Struct(shape))
  return schema
}

const collectToolDefinitions = (): ReadonlyArray<ToolDefinition> => {
  const definitions: ToolDefinition[] = []
  const registrar: McpToolRegistrar = {
    tool(name, description, schema, handler) {
      definitions.push({
        name,
        description,
        schema,
        handler: handler as (params: unknown) => Effect.Effect<McpToolResult>,
      })
    },
  }

  registerSystemHealthTool(registrar)
  registerFindErrorsTool(registrar)
  registerInspectTraceTool(registrar)
  registerSearchLogsTool(registrar)
  registerSearchTracesTool(registrar)
  registerServiceOverviewTool(registrar)
  registerDiagnoseServiceTool(registrar)
  registerFindSlowTracesTool(registrar)
  registerErrorDetailTool(registrar)
  registerListMetricsTool(registrar)

  return definitions
}

const toolDefinitions = collectToolDefinitions()

export const McpToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* EffectMcpServer.McpServer

    for (const definition of toolDefinitions) {
      const parameterSchema = Schema.Struct(definition.schema)
      const decode = Schema.validateEither(parameterSchema)

      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: definition.name,
          description: definition.description,
          inputSchema: toInputSchema(definition.schema),
        }),
        handle: (payload) => {
          const decoded = decode(payload)

          if (decoded._tag === "Left") {
            const errorMessage = ParseResult.TreeFormatter.formatErrorSync(decoded.left)

            return Effect.succeed(
              toCallToolResult({
                isError: true,
                content: [{ type: "text", text: `Invalid parameters: ${errorMessage}` }],
              }),
            )
          }

          return definition.handler(decoded.right).pipe(
            Effect.map(toCallToolResult),
            Effect.catchAllDefect((error) =>
              Effect.succeed(
                toCallToolResult({
                  isError: true,
                  content: [{ type: "text", text: `Error: ${toErrorMessage(error)}` }],
                }),
              ),
            ),
          )
        },
      })
    }
  }),
)
