import {
  optionalNumberParam,
  optionalStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { formatNextSteps } from "../lib/next-steps"
import { exploreAttributeKeys, exploreAttributeValues } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerExploreAttributesTool(server: McpToolRegistrar) {
  server.tool(
    "explore_attributes",
    "Discover available attribute keys and their values. Call this before query_data or search_traces when you need to filter by custom attributes. " +
    "Use source=services to discover available environments and commit SHAs for comparison.",
    Schema.Struct({
      source: Schema.Literals(["traces", "metrics", "services"]).annotate({
        description:
          "Data source. Use 'traces' to discover span/resource attribute keys (e.g. http.method, user.id). " +
          "Use 'metrics' to discover metric attribute keys. " +
          "Use 'services' to discover available environments and commit SHAs.",
      }),
      scope: optionalStringParam("Attribute scope for traces: 'span' (default) or 'resource'. Ignored for metrics/services."),
      key: optionalStringParam("When provided, returns values for this key instead of listing all keys"),
      service_name: optionalStringParam("Filter by service name"),
      start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss)"),
      limit: optionalNumberParam("Max results (default 50)"),
    }),
    (params) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)
        const lim = params.limit ?? 50
        const scope = (params.scope ?? "span") as "span" | "resource"
        const tenant = yield* resolveTenant
        const executorLayer = makeTinybirdExecutorFromTenant(tenant)
        const mapError = (e: any) => new McpQueryError({ message: e.message, pipe: "explore_attributes" })

        const baseInput = {
          source: params.source as "traces" | "metrics" | "services",
          scope,
          service: params.service_name ?? undefined,
          timeRange: { startTime: st, endTime: et },
          limit: lim,
        }

        if (params.key) {
          // Return values for a specific key
          const values = yield* exploreAttributeValues({ ...baseInput, key: params.key }).pipe(
            Effect.provide(executorLayer),
            Effect.mapError(mapError),
          )

          const lines: string[] = [
            `## Attribute Values: ${params.key}`,
            `Source: ${params.source} (${scope})`,
            `Time range: ${st} — ${et}`,
            ``,
          ]

          if (values.length === 0) {
            lines.push("No values found for this key.")
          } else {
            lines.push(formatTable(["Value", "Count"], Arr.map(values, (v) => [v.value, formatNumber(v.count)])))
          }

          lines.push(formatNextSteps([
            `\`query_data source="traces" kind="timeseries" attribute_key="${params.key}" attribute_value="<value>"\` — chart traces filtered by this attribute`,
          ]))

          return {
            content: createDualContent(lines.join("\n"), {
              tool: "explore_attributes" as any,
              data: { source: params.source, scope, key: params.key, timeRange: { start: st, end: et }, values: [...values] },
            }),
          }
        }

        // Services source uses different pipe - delegate to queryTinybird directly
        if (params.source === "services") {
          const result = yield* queryTinybird("services_facets", { start_time: st, end_time: et })

          const environments = Arr.filter(result.data, (r: any) => r.facetType === "environment")
          const commitShas = Arr.filter(result.data, (r: any) => r.facetType === "commit_sha")

          const lines: string[] = [`## Available Environments & Deployments`, `Time range: ${st} — ${et}`, ``]

          if (environments.length > 0) {
            lines.push(`### Environments`)
            lines.push(formatTable(["Environment", "Span Count"], Arr.map(environments, (r: any) => [String(r.name), formatNumber(r.count ?? 0)])))
          }
          if (commitShas.length > 0) {
            lines.push(``, `### Commit SHAs`)
            lines.push(formatTable(["Commit SHA", "Span Count"], Arr.map(commitShas, (r: any) => [String(r.name), formatNumber(r.count ?? 0)])))
          }

          const nextSteps: string[] = []
          if (environments.length > 0) nextSteps.push(`\`list_services environment="${String(environments[0].name)}"\` — see services in this environment`)
          if (commitShas.length > 1) nextSteps.push('`compare_periods` — compare performance between deploys')
          lines.push(formatNextSteps(nextSteps))

          return {
            content: createDualContent(lines.join("\n"), {
              tool: "explore_attributes" as any,
              data: {
                source: "services",
                timeRange: { start: st, end: et },
                keys: [
                  ...Arr.map(environments, (r: any) => ({ key: `environment:${String(r.name)}`, count: Number(r.count ?? 0) })),
                  ...Arr.map(commitShas, (r: any) => ({ key: `commit_sha:${String(r.name)}`, count: Number(r.count ?? 0) })),
                ],
              },
            }),
          }
        }

        // List keys for traces or metrics
        const keys = yield* exploreAttributeKeys(baseInput).pipe(
          Effect.provide(executorLayer),
          Effect.mapError(mapError),
        )

        const lines: string[] = [
          `## Attribute Keys`,
          `Source: ${params.source} (${scope})`,
          `Time range: ${st} — ${et}`,
          ``,
        ]

        if (keys.length === 0) {
          lines.push("No attribute keys found.")
        } else {
          lines.push(formatTable(["Key", "Count"], Arr.map(keys, (k) => [k.key, formatNumber(k.count)])))
        }

        const nextSteps = Arr.map(Arr.take(keys, 3), (k) =>
          `\`explore_attributes source="${params.source}" key="${k.key}"\` — see values for this key`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "explore_attributes" as any,
            data: { source: params.source, scope, timeRange: { start: st, end: et }, keys: [...keys] },
          }),
        }
      }),
  )
}
