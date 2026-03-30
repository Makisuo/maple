import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { formatNextSteps } from "../lib/next-steps"

export function registerExploreAttributesTool(server: McpToolRegistrar) {
  server.tool(
    "explore_attributes",
    "Discover available attribute keys and values for traces and metrics. Also discover available environments and commit SHAs (source=services). Use before query_data when you need to filter by custom attributes.",
    Schema.Struct({
      source: Schema.Literals(["traces", "metrics", "services"]).annotate({
        description: "Data source: traces, metrics, or services (for environments/commit SHAs)",
      }),
      scope: optionalStringParam("Attribute scope for traces: span or resource (default: span). Ignored for metrics"),
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
        const scope = params.scope ?? "span"

        if (params.source === "traces") {
          if (params.key) {
            // Return values for a specific key
            const pipeName = scope === "resource"
              ? "resource_attribute_values" as const
              : "span_attribute_values" as const
            const result = yield* queryTinybird(pipeName, {
              start_time: st,
              end_time: et,
              attribute_key: params.key,
              limit: lim,
            })

            const lines: string[] = [
              `## Attribute Values: ${params.key}`,
              `Source: traces (${scope})`,
              `Time range: ${st} — ${et}`,
              ``,
            ]

            if (result.data.length === 0) {
              lines.push("No values found for this key.")
            } else {
              const headers = ["Value", "Count"]
              const rows = result.data.map((r: any) => [
                String(r.attributeValue ?? ""),
                formatNumber(r.usageCount ?? 0),
              ])
              lines.push(formatTable(headers, rows))
            }

            const nextSteps = [
              `\`query_data source="traces" kind="timeseries" attribute_key="${params.key}" attribute_value="<value>"\` — chart traces filtered by this attribute`,
            ]
            lines.push(formatNextSteps(nextSteps))

            return {
              content: createDualContent(lines.join("\n"), {
                tool: "explore_attributes" as any,
                data: {
                  source: "traces",
                  scope,
                  key: params.key,
                  timeRange: { start: st, end: et },
                  values: result.data.map((r: any) => ({
                    value: String(r.attributeValue ?? ""),
                    count: Number(r.usageCount ?? 0),
                  })),
                },
              }),
            }
          }

          // List keys
          const pipeName = scope === "resource"
            ? "resource_attribute_keys" as const
            : "span_attribute_keys" as const
          const result = yield* queryTinybird(pipeName, {
            start_time: st,
            end_time: et,
            limit: lim,
          })

          const lines: string[] = [
            `## Attribute Keys`,
            `Source: traces (${scope})`,
            `Time range: ${st} — ${et}`,
            ``,
          ]

          if (result.data.length === 0) {
            lines.push("No attribute keys found.")
          } else {
            const headers = ["Key", "Count"]
            const rows = result.data.map((r: any) => [
              String(r.attributeKey ?? ""),
              formatNumber(r.usageCount ?? 0),
            ])
            lines.push(formatTable(headers, rows))
          }

          const sampleKeys = result.data.slice(0, 3)
          const nextSteps = sampleKeys.map((r: any) => {
            const key = String(r.attributeKey ?? "")
            return `\`explore_attributes source="traces" key="${key}"\` — see values for this key`
          })
          lines.push(formatNextSteps(nextSteps))

          return {
            content: createDualContent(lines.join("\n"), {
              tool: "explore_attributes" as any,
              data: {
                source: "traces",
                scope,
                timeRange: { start: st, end: et },
                keys: result.data.map((r: any) => ({
                  key: String(r.attributeKey ?? ""),
                  count: Number(r.usageCount ?? 0),
                })),
              },
            }),
          }
        }

        // Services source — discover environments and commit SHAs
        if (params.source === "services") {
          const result = yield* queryTinybird("services_facets", {
            start_time: st,
            end_time: et,
          })

          const environments = result.data.filter((r: any) => r.facetType === "environment")
          const commitShas = result.data.filter((r: any) => r.facetType === "commit_sha")

          const lines: string[] = [
            `## Available Environments & Deployments`,
            `Time range: ${st} — ${et}`,
            ``,
          ]

          if (environments.length > 0) {
            lines.push(`### Environments`)
            const headers = ["Environment", "Span Count"]
            const rows = environments.map((r: any) => [
              String(r.name),
              formatNumber(r.count ?? 0),
            ])
            lines.push(formatTable(headers, rows))
          } else {
            lines.push("No environments found.")
          }

          if (commitShas.length > 0) {
            lines.push(``, `### Commit SHAs`)
            const headers = ["Commit SHA", "Span Count"]
            const rows = commitShas.map((r: any) => [
              String(r.name),
              formatNumber(r.count ?? 0),
            ])
            lines.push(formatTable(headers, rows))
          }

          const nextSteps: string[] = []
          if (environments.length > 0) {
            const topEnv = String(environments[0].name)
            nextSteps.push(`\`system_health environment="${topEnv}"\` — see health for this environment`)
          }
          if (commitShas.length > 1) {
            nextSteps.push('`compare_periods` — compare performance between deploys')
          }
          lines.push(formatNextSteps(nextSteps))

          return {
            content: createDualContent(lines.join("\n"), {
              tool: "explore_attributes" as any,
              data: {
                source: "services",
                timeRange: { start: st, end: et },
                keys: [
                  ...environments.map((r: any) => ({
                    key: `environment:${String(r.name)}`,
                    count: Number(r.count ?? 0),
                  })),
                  ...commitShas.map((r: any) => ({
                    key: `commit_sha:${String(r.name)}`,
                    count: Number(r.count ?? 0),
                  })),
                ],
              },
            }),
          }
        }

        // Metrics source
        if (params.key) {
          // Metrics don't have a values endpoint — return helpful message
          return {
            content: [{
              type: "text" as const,
              text: "Metric attribute value exploration is not yet supported. Use `query_data source=\"metrics\"` with `attribute_key` and `attribute_value` directly.",
            }],
          }
        }

        const result = yield* queryTinybird("metric_attribute_keys", {
          start_time: st,
          end_time: et,
          ...(params.service_name && { metric_name: params.service_name }),
          limit: lim,
        })

        const lines: string[] = [
          `## Metric Attribute Keys`,
          `Time range: ${st} — ${et}`,
          ``,
        ]

        if (result.data.length === 0) {
          lines.push("No metric attribute keys found.")
        } else {
          const headers = ["Key", "Count"]
          const rows = result.data.map((r: any) => [
            String(r.attributeKey ?? ""),
            formatNumber(r.usageCount ?? 0),
          ])
          lines.push(formatTable(headers, rows))
        }

        const nextSteps = result.data.slice(0, 3).map((r: any) => {
          const key = String(r.attributeKey ?? "")
          return `\`query_data source="metrics" kind="timeseries" metric_name="<name>" metric_type="<type>" attribute_key="${key}"\` — group by this attribute`
        })
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "explore_attributes" as any,
            data: {
              source: "metrics",
              timeRange: { start: st, end: et },
              keys: result.data.map((r: any) => ({
                key: String(r.attributeKey ?? ""),
                count: Number(r.usageCount ?? 0),
              })),
            },
          }),
        }
      }),
  )
}
