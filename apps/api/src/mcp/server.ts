import { McpSchema, McpServer as EffectMcpServer } from "effect/unstable/ai"
import { Effect, Layer, Schema, ServiceMap } from "effect"
import { registerFindErrorsTool } from "./tools/find-errors"
import { registerInspectTraceTool } from "./tools/inspect-trace"
import { registerSearchLogsTool } from "./tools/search-logs"
import { registerSearchTracesTool } from "./tools/search-traces"
import { registerDiagnoseServiceTool } from "./tools/diagnose-service"
import { registerFindSlowTracesTool } from "./tools/find-slow-traces"
import { registerErrorDetailTool } from "./tools/error-detail"
import { registerListMetricsTool } from "./tools/list-metrics"
import { registerQueryDataTool } from "./tools/query-data"
import { registerServiceMapTool } from "./tools/service-map"
import { registerListAlertRulesTool } from "./tools/list-alert-rules"
import { registerListAlertIncidentsTool } from "./tools/list-alert-incidents"
import { registerGetIncidentTimelineTool } from "./tools/get-incident-timeline"
import { registerCreateAlertRuleTool } from "./tools/create-alert-rule"
import { registerListDashboardsTool } from "./tools/list-dashboards"
import { registerGetDashboardTool } from "./tools/get-dashboard"
import { registerCreateDashboardTool } from "./tools/create-dashboard"
import { registerUpdateDashboardTool } from "./tools/update-dashboard"
import { registerGetAlertRuleTool } from "./tools/get-alert-rule"
import { registerComparePeriodsTool } from "./tools/compare-periods"
import { registerExploreAttributesTool } from "./tools/explore-attributes"
import { registerListServicesTool } from "./tools/list-services"
import { registerGetServiceTopOperationsTool } from "./tools/get-service-top-operations"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./tools/types"

interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly schema: Schema.Decoder<unknown, never>
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
  if (Schema.isSchemaError(error)) {
    return `${String(error)}. Check the "${definition.name}" tool schema for valid parameter names and types.`
  }
  return String(error)
}

const collectToolDefinitions = (): ReadonlyArray<ToolDefinition> => {
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

  registerFindErrorsTool(registrar)
  registerInspectTraceTool(registrar)
  registerSearchLogsTool(registrar)
  registerSearchTracesTool(registrar)
  registerDiagnoseServiceTool(registrar)
  registerFindSlowTracesTool(registrar)
  registerErrorDetailTool(registrar)
  registerListMetricsTool(registrar)
  registerQueryDataTool(registrar)
  registerServiceMapTool(registrar)

  // Alert management
  registerListAlertRulesTool(registrar)
  registerGetAlertRuleTool(registrar)
  registerListAlertIncidentsTool(registrar)
  registerGetIncidentTimelineTool(registrar)
  registerCreateAlertRuleTool(registrar)

  // Dashboard management
  registerListDashboardsTool(registrar)
  registerGetDashboardTool(registrar)
  registerCreateDashboardTool(registrar)
  registerUpdateDashboardTool(registrar)

  // Workflow tools
  registerComparePeriodsTool(registrar)
  registerExploreAttributesTool(registrar)

  // Service discovery
  registerListServicesTool(registrar)
  registerGetServiceTopOperationsTool(registrar)

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
          Effect.gen(function* () {
            const decoded = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(definition.schema)(payload),
              catch: (error) => error,
            }).pipe(
              Effect.mapError((error) => {
                const errorMessage = toDecodeErrorMessage(definition, error)
                return { _tag: "@maple/mcp/decode-error" as const, errorMessage }
              }),
            )

            return yield* definition.handler(decoded).pipe(
              Effect.tap(() => Effect.logInfo("Tool completed")),
              Effect.map(toCallToolResult),
            )
          }).pipe(
            Effect.catchTag("@maple/mcp/decode-error", (error) =>
              Effect.logWarning("Invalid parameters").pipe(
                Effect.annotateLogs({ error: error.errorMessage }),
                Effect.as(
                  toCallToolResult({
                    isError: true,
                    content: [{ type: "text", text: `Invalid parameters: ${error.errorMessage}` }],
                  }),
                ),
              ),
            ),
            Effect.catchTags({
              "@maple/mcp/errors/McpQueryError": (error) =>
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
              "@maple/mcp/errors/McpTenantError": (error) =>
                Effect.logError(`Tool error: ${error.message}`).pipe(
                  Effect.annotateLogs({ errorTag: error._tag }),
                  Effect.as(
                    toCallToolResult({
                      isError: true,
                      content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
                    }),
                  ),
                ),
              "@maple/mcp/errors/McpAuthMissingError": (error) =>
                Effect.logError(`Auth error: ${error.message}`).pipe(
                  Effect.annotateLogs({ errorTag: error._tag }),
                  Effect.as(
                    toCallToolResult({
                      isError: true,
                      content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
                    }),
                  ),
                ),
              "@maple/mcp/errors/McpAuthInvalidError": (error) =>
                Effect.logError(`Auth error: ${error.message}`).pipe(
                  Effect.annotateLogs({ errorTag: error._tag }),
                  Effect.as(
                    toCallToolResult({
                      isError: true,
                      content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
                    }),
                  ),
                ),
              "@maple/mcp/errors/McpInvalidTenantError": (error) =>
                Effect.logError(`Tenant validation error [${error.field}]: ${error.message}`).pipe(
                  Effect.annotateLogs({ errorTag: error._tag, field: error.field }),
                  Effect.as(
                    toCallToolResult({
                      isError: true,
                      content: [{ type: "text", text: `${error._tag} (${error.field}): ${error.message}` }],
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
          ),
      }),
    ).pipe(Effect.asVoid),
  ),
)
