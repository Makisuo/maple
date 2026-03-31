import {
  requiredStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { formatDurationFromMs, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { inspectTrace, type SpanNode } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerInspectTraceTool(server: McpToolRegistrar) {
  server.tool(
    "inspect_trace",
    "Get the full span tree and logs for a single trace. Use this to understand request flow, find bottlenecks, and see error context.",
    Schema.Struct({
      trace_id: requiredStringParam("The trace ID to inspect"),
    }),
    ({ trace_id }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant

        const result = yield* inspectTrace(trace_id).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "span_hierarchy" })),
        )

        if (result.spanCount === 0) {
          return { content: [{ type: "text", text: `No spans found for trace ${trace_id}` }] }
        }

        const lines: string[] = [
          `## Trace ${trace_id} (${result.serviceCount} services, ${result.spanCount} spans, ${formatDurationFromMs(result.rootDurationMs)})`,
          ``,
        ]

        function renderNode(node: SpanNode, prefix: string, isLast: boolean) {
          const connector = prefix === "" ? "" : isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 "
          const status = node.statusCode === "Error" ? " [Error]" : node.statusCode === "Ok" ? " [Ok]" : ""
          lines.push(
            `${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}`,
          )
          const detailPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
          if (node.statusCode === "Error" && node.statusMessage) {
            lines.push(`${detailPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
          }
          const attrEntries = Object.entries(node.attributes)
          if (attrEntries.length > 0) {
            const attrStr = attrEntries.slice(0, 5).map(([k, v]) => `${k}=${truncate(String(v), 60)}`).join(", ")
            lines.push(`${detailPrefix}    {${attrStr}}`)
          }
          const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
          node.children.forEach((child, i) => {
            renderNode(child, childPrefix, i === node.children.length - 1)
          })
        }

        for (const root of result.spans) {
          renderNode(root, "", true)
        }

        if (result.logs.length > 0) {
          lines.push(``, `Related Logs (${result.logs.length}):`)
          for (const log of result.logs) {
            const ts = log.timestamp
            const time = ts.split(" ")[1] ?? ts
            const sev = log.severityText.padEnd(5)
            lines.push(`  ${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 100)}`)
          }
        }

        const serviceSet = new Set(result.spans.map(function collectServices(n: SpanNode): string[] {
          return [n.serviceName, ...n.children.flatMap(collectServices)]
        }).flat())

        const nextSteps: string[] = []
        const hasErrors = result.spans.some(function hasError(n: SpanNode): boolean {
          return n.statusCode === "Error" || n.children.some(hasError)
        })
        if (hasErrors) {
          nextSteps.push(`\`search_logs trace_id="${trace_id}"\` — see all logs for this trace`)
        }
        for (const svc of [...serviceSet].slice(0, 2)) {
          nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate this service`)
        }
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "inspect_trace",
            data: {
              traceId: trace_id,
              serviceCount: result.serviceCount,
              spanCount: result.spanCount,
              rootDurationMs: result.rootDurationMs,
              spans: [...result.spans] as any,
              logs: result.logs.map((l) => ({ ...l })),
            },
          }),
        }
      }),
  )
}
