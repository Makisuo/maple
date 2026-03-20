import { McpSchema, McpServer as EffectMcpServer } from "effect/unstable/ai"
import { Effect, Layer, Schema, ServiceMap } from "effect"
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
import { registerQueryDataTool } from "./tools/query-data"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./tools/types"

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly schema: Schema.Top & { readonly DecodingServices: never }
  readonly handler: (params: unknown) => Effect.Effect<McpToolResult, McpToolError, any>
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && "error" in error && (error as any).error != null) {
    const inner = (error as any).error
    return inner instanceof Error ? inner.message : String(inner)
  }
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

const toInputSchema = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : document.schema
}

const toDecodeErrorMessage = (definition: ToolDefinition, error: unknown): string => {
  const base = Schema.isSchemaError(error) ? String(error) : String(error)

  if (definition.name !== "query_data") {
    return base
  }

  return [
    base,
    "Supported combinations:",
    "- traces timeseries: metric=count|avg_duration|p50_duration|p95_duration|p99_duration|error_rate, group_by=service|span_name|status_code|http_method|attribute|none",
    "- traces breakdown: metric=count|avg_duration|p50_duration|p95_duration|p99_duration|error_rate, group_by=service|span_name|status_code|http_method|attribute",
    "- logs timeseries: metric=count, group_by=service|severity|none",
    "- logs breakdown: metric=count, group_by=service|severity",
    "- metrics timeseries: metric=avg|sum|min|max|count, group_by=service|none",
    "- metrics breakdown: metric=avg|sum|count, group_by=service",
    "Use `list_metrics` first to discover `metric_name` and `metric_type`.",
  ].join("\n")
}

export const collectToolDefinitions = (): ReadonlyArray<ToolDefinition> => {
  const definitions: ToolDefinition[] = []
  const registrar: McpToolRegistrar = {
    tool(name, description, schema, handler) {
      definitions.push({
        name,
        description,
        schema,
        handler: handler as (params: unknown) => Effect.Effect<McpToolResult, McpToolError>,
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
  registerQueryDataTool(registrar)

  return definitions
}

const toolDefinitions = collectToolDefinitions()

export const McpToolsLive = Layer.effectDiscard(
  EffectMcpServer.McpServer.use((server) =>
    Effect.forEach(toolDefinitions, (definition) =>
      server.addTool({
        tool: new McpSchema.Tool({
          name: definition.name,
          description: definition.description,
          inputSchema: toInputSchema(definition.schema),
        }),
        annotations: ServiceMap.empty(),
        handle: (payload) =>
          Effect.suspend(() => {
            let decoded: unknown

            try {
              decoded = Schema.decodeUnknownSync(definition.schema)(payload)
            } catch (error) {
              const errorMessage = toDecodeErrorMessage(definition, error)
              return Effect.logWarning("Invalid parameters").pipe(
                Effect.annotateLogs({ error: errorMessage }),
                Effect.as(
                  toCallToolResult({
                    isError: true,
                    content: [{ type: "text", text: `Invalid parameters: ${errorMessage}` }],
                  }),
                ),
              )
            }

            return definition.handler(decoded).pipe(
              Effect.tap(() => Effect.logInfo("Tool completed")),
              Effect.map(toCallToolResult),
              Effect.catchTags({
                McpQueryError: (error) =>
                  Effect.logError(`Tool error: ${error.message}`).pipe(
                    Effect.annotateLogs({
                      errorTag: error._tag,
                      pipe: error.pipe,
                    }),
                    Effect.as(
                      toCallToolResult({
                        isError: true,
                        content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
                      }),
                    ),
                  ),
                McpTenantError: (error) =>
                  Effect.logError(`Tool error: ${error.message}`).pipe(
                    Effect.annotateLogs({
                      errorTag: error._tag,
                    }),
                    Effect.as(
                      toCallToolResult({
                        isError: true,
                        content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
                      }),
                    ),
                  ),
              }),
              Effect.catchDefect((error) =>
                Effect.logError(`Tool defect: ${toErrorMessage(error)}`).pipe(
                  Effect.as(
                    toCallToolResult({
                      isError: true,
                      content: [{ type: "text", text: `Error: ${toErrorMessage(error)}` }],
                    }),
                  ),
                ),
              ),
              Effect.annotateLogs({ tool: definition.name }),
            )
          }),
      }),
    ).pipe(Effect.asVoid),
  ),
)
