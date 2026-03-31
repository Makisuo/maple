import { Effect, Layer, Redacted, Schema, ServiceMap } from "effect"
import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"
import { CliConfig } from "./CliConfig"

export class MapleApiError extends Schema.TaggedErrorClass<MapleApiError>()(
  "MapleApiError",
  {
    message: Schema.String,
    pipe: Schema.optional(Schema.String),
  },
) {}

export interface MapleClientShape {
  readonly queryTinybird: <T = any>(
    pipe: TinybirdPipe,
    params?: Record<string, unknown>,
  ) => Effect.Effect<{ data: Array<T> }, MapleApiError>

  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<any, MapleApiError>

  readonly queryEngine: (
    request: {
      startTime: string
      endTime: string
      query: unknown
    },
  ) => Effect.Effect<{ result: any }, MapleApiError>
}

let nextId = 1

export class MapleClient extends ServiceMap.Service<MapleClient, MapleClientShape>()(
  "MapleClient",
  {
    make: Effect.gen(function* () {
      const config = yield* CliConfig
      const mcpUrl = config.mcpUrl
      const token = Redacted.value(config.apiToken)

      // Initialize MCP session
      let sessionId: string | null = null

      const ensureSession = Effect.gen(function* () {
        if (sessionId) return sessionId

        const res = yield* Effect.tryPromise({
          try: async () => {
            const resp = await fetch(mcpUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: nextId++,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: { name: "maple-cli", version: "0.1.0" },
                },
              }),
            })
            const sid = resp.headers.get("mcp-session-id")
            if (!sid) throw new Error("No Mcp-Session-Id header in response")
            return sid
          },
          catch: (error) =>
            new MapleApiError({
              message: `MCP init failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })

        sessionId = res
        return res
      })

      const callTool = (name: string, args: Record<string, unknown>): Effect.Effect<any, MapleApiError> =>
        Effect.gen(function* () {
          const sid = yield* ensureSession

          const result = yield* Effect.tryPromise({
            try: async () => {
              const resp = await fetch(mcpUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${token}`,
                  "mcp-session-id": sid,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: nextId++,
                  method: "tools/call",
                  params: { name, arguments: args },
                }),
              })
              if (!resp.ok) {
                const text = await resp.text()
                throw new Error(`HTTP ${resp.status}: ${text}`)
              }
              return await resp.json()
            },
            catch: (error) =>
              new MapleApiError({
                message: `MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })

          const res = result as any
          if (res.error) {
            return yield* Effect.fail(
              new MapleApiError({ message: `MCP error: ${JSON.stringify(res.error)}` }),
            )
          }

          // Extract structured data from the dual content format
          // Second text content item contains JSON with __maple_ui marker
          const content = res.result?.content ?? []
          const textContent = content.filter((c: any) => c.type === "text" && !c.text?.includes("__maple_ui")).map((c: any) => c.text).join("\n")

          for (const c of content) {
            if (c.type === "text" && c.text?.includes("__maple_ui")) {
              try {
                const parsed = JSON.parse(c.text)
                // Preserve both structured data and human-readable text
                parsed._text = textContent
                return parsed
              } catch {
                // fall through
              }
            }
          }

          // Return raw text content if no structured data found
          return { _raw: true, text: textContent, content }
        })

      // Query Tinybird pipes by calling MCP tools that wrap them
      // We map pipe names to MCP tool calls
      const PIPE_TO_TOOL: Record<string, string> = {
        service_overview: "list_services",
        errors_by_type: "find_errors",
        list_traces: "search_traces",
        span_hierarchy: "inspect_trace",
        list_logs: "search_logs",
        error_detail_traces: "error_detail",
        service_dependencies: "service_map",
        traces_duration_stats: "find_slow_traces",
        errors_summary: "find_errors",
        span_attribute_keys: "explore_attributes",
        span_attribute_values: "explore_attributes",
        resource_attribute_keys: "explore_attributes",
        resource_attribute_values: "explore_attributes",
        metric_attribute_keys: "explore_attributes",
        services_facets: "explore_attributes",
      }

      const queryTinybird = <T = any>(pipe: TinybirdPipe, params?: Record<string, unknown>): Effect.Effect<{ data: Array<T> }, MapleApiError> =>
        Effect.gen(function* () {
          // Direct MCP tool calls with proper param mapping
          const sid = yield* ensureSession
          const id = nextId++

          // Call the internal _query endpoint directly via a custom tool call
          // Since MCP wraps the tinybird queries, we call the tool and parse its structured output
          const result = yield* Effect.tryPromise({
            try: async () => {
              // Use tools/call to call the appropriate tool
              const toolName = PIPE_TO_TOOL[pipe]
              if (!toolName) {
                throw new Error(`No MCP tool mapping for pipe: ${pipe}`)
              }

              // Map params to MCP tool arguments
              const args = mapParamsToToolArgs(pipe, params ?? {})

              const resp = await fetch(mcpUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${token}`,
                  "mcp-session-id": sid,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  method: "tools/call",
                  params: { name: toolName, arguments: args },
                }),
              })
              if (!resp.ok) {
                const text = await resp.text()
                throw new Error(`HTTP ${resp.status}: ${text}`)
              }
              return await resp.json()
            },
            catch: (error) =>
              new MapleApiError({
                message: `Query ${pipe} failed: ${error instanceof Error ? error.message : String(error)}`,
                pipe,
              }),
          })

          const res = result as any
          if (res.error) {
            return yield* Effect.fail(
              new MapleApiError({ message: `MCP error: ${JSON.stringify(res.error)}`, pipe }),
            )
          }

          // Parse structured data from dual content (second text item has __maple_ui marker)
          const content = res.result?.content ?? []
          for (const c of content) {
            if (c.type === "text" && c.text?.includes("__maple_ui")) {
              try {
                const parsed = JSON.parse(c.text)
                return { data: extractDataArray(pipe, parsed) as T[] }
              } catch {
                // fall through
              }
            }
          }

          return { data: [] as T[] }
        })

      const queryEngine = (request: { startTime: string; endTime: string; query: unknown }): Effect.Effect<{ result: any }, MapleApiError> => {
        const q = request.query as any
        return callTool("query_data", {
          source: q.source,
          kind: q.kind,
          metric: q.metric,
          group_by: q.groupBy?.[0] ?? q.groupBy,
          start_time: request.startTime,
          end_time: request.endTime,
          service_name: q.filters?.serviceName,
          span_name: q.filters?.spanName,
          limit: q.limit,
          bucket_seconds: q.bucketSeconds,
          ...(q.filters?.attributeFilters?.[0] && {
            attribute_key: q.filters.attributeFilters[0].key,
            attribute_value: q.filters.attributeFilters[0].value,
          }),
        }).pipe(
          Effect.map((result) => {
            if (result._raw) {
              return { result: { kind: q.kind, source: q.source, data: [] } }
            }
            return { result: { kind: q.kind, source: q.source, data: result.data ?? result } }
          }),
        )
      }

      return { queryTinybird, callTool, queryEngine }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

function mapParamsToToolArgs(pipe: string, params: Record<string, unknown>): Record<string, unknown> {
  // Map tinybird pipe params to MCP tool arguments
  switch (pipe) {
    case "service_overview":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        environment: params.environments,
      }
    case "errors_by_type":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.services,
        environment: params.deployment_envs,
        limit: params.limit,
      }
    case "list_traces":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.any_service ?? params.service,
        span_name: params.any_span_name ?? params.span_name,
        has_error: params.has_error,
        min_duration_ms: params.min_duration_ms,
        max_duration_ms: params.max_duration_ms,
        http_method: params.http_method,
        trace_id: params.trace_id,
        attribute_key: params.attribute_filter_key,
        attribute_value: params.attribute_filter_value,
        root_only: params.service ? true : false,
        offset: params.offset,
        limit: params.limit,
      }
    case "span_hierarchy":
      return { trace_id: params.trace_id }
    case "list_logs":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.service,
        severity: params.severity,
        search: params.body_search,
        trace_id: params.trace_id,
        offset: params.offset,
        limit: params.limit,
      }
    case "error_detail_traces":
      return {
        error_type: params.error_type,
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.services,
        limit: params.limit,
      }
    case "service_dependencies":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service_name: params.service_name,
        environment: params.deployment_env,
      }
    case "traces_duration_stats":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.service,
      }
    case "errors_summary":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.services,
        environment: params.environments,
      }
    case "span_attribute_keys":
      return { source: "traces", scope: "span", start_time: params.start_time, end_time: params.end_time, service_name: params.service_name, limit: params.limit }
    case "resource_attribute_keys":
      return { source: "traces", scope: "resource", start_time: params.start_time, end_time: params.end_time, service_name: params.service_name, limit: params.limit }
    case "span_attribute_values":
      return { source: "traces", scope: "span", key: params.attribute_key, start_time: params.start_time, end_time: params.end_time, service_name: params.service_name, limit: params.limit }
    case "resource_attribute_values":
      return { source: "traces", scope: "resource", key: params.attribute_key, start_time: params.start_time, end_time: params.end_time, service_name: params.service_name, limit: params.limit }
    case "metric_attribute_keys":
      return { source: "metrics", start_time: params.start_time, end_time: params.end_time, limit: params.limit }
    case "services_facets":
      return { source: "services", start_time: params.start_time, end_time: params.end_time }
    case "logs_count":
      return {
        start_time: params.start_time,
        end_time: params.end_time,
        service: params.service,
        severity: params.severity,
        search: params.body_search,
        trace_id: params.trace_id,
      }
    default:
      return params
  }
}

function extractDataArray(pipe: string, parsed: any): any[] {
  // The structured output has { __maple_ui, tool, data: { ... } }
  const data = parsed.data ?? parsed

  switch (pipe) {
    case "service_overview":
      return data.services ?? []
    case "errors_by_type":
      return data.errors ?? []
    case "list_traces":
      return data.traces ?? []
    case "error_detail_traces":
      return data.traces ?? []
    case "service_dependencies":
      return data.edges ?? []
    case "errors_summary":
      return [data]
    case "span_hierarchy":
      return data.spans ?? []
    case "list_logs":
      return data.logs ?? []
    case "logs_count":
      return [{ count: data.total ?? 0 }]
    case "traces_duration_stats":
      return data.stats ? [data.stats] : [data]
    default:
      if (Array.isArray(data)) return data
      if (data.keys) return data.keys
      if (data.values) return data.values
      return [data]
  }
}
