import {
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { formatDurationFromMs, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

interface SpanNode {
  spanId: string
  parentSpanId: string
  spanName: string
  serviceName: string
  durationMs: number
  statusCode: string
  statusMessage: string
  children: SpanNode[]
}

export function registerInspectTraceTool(server: McpToolRegistrar) {
  server.tool(
    "inspect_trace",
    "Get the full span tree and logs for a single trace. Use this to understand request flow, find bottlenecks, and see error context.",
    Schema.Struct({
      trace_id: requiredStringParam("The trace ID to inspect"),
    }),
    ({ trace_id }) =>
      Effect.gen(function* () {
        const [spansResult, logsResult] = yield* Effect.all(
          [
            queryTinybird("span_hierarchy", { trace_id }),
            queryTinybird("list_logs", { trace_id, limit: 50 }),
          ],
          { concurrency: "unbounded" },
        )

        const spans = spansResult.data
        if (spans.length === 0) {
          return { content: [{ type: "text", text: `No spans found for trace ${trace_id}` }] }
        }

        // Build span tree
        const nodeMap = new Map<string, SpanNode>()
        const roots: SpanNode[] = []

        for (const span of spans) {
          nodeMap.set(span.spanId, {
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            spanName: span.spanName,
            serviceName: span.serviceName,
            durationMs: span.durationMs,
            statusCode: span.statusCode,
            statusMessage: span.statusMessage,
            children: [],
          })
        }

        for (const node of nodeMap.values()) {
          if (node.parentSpanId && nodeMap.has(node.parentSpanId)) {
            nodeMap.get(node.parentSpanId)!.children.push(node)
          } else {
            roots.push(node)
          }
        }

        const serviceSet = new Set(spans.map((s) => s.serviceName))
        const rootDuration = roots[0]?.durationMs ?? 0

        const lines: string[] = [
          `## Trace ${trace_id} (${serviceSet.size} services, ${spans.length} spans, ${formatDurationFromMs(rootDuration)})`,
          ``,
        ]

        function renderNode(node: SpanNode, prefix: string, isLast: boolean) {
          const connector = prefix === "" ? "" : isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 "
          const status = node.statusCode === "Error" ? " [Error]" : node.statusCode === "Ok" ? " [Ok]" : ""
          lines.push(
            `${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}`,
          )
          if (node.statusCode === "Error" && node.statusMessage) {
            const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
            lines.push(`${childPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
          }
          const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
          node.children.forEach((child, i) => {
            renderNode(child, childPrefix, i === node.children.length - 1)
          })
        }

        for (const root of roots) {
          renderNode(root, "", true)
        }

        const logs = logsResult.data
        if (logs.length > 0) {
          lines.push(``, `Related Logs (${logs.length}):`)
          for (const log of logs.slice(0, 20)) {
            const ts = String(log.timestamp)
            const time = ts.split(" ")[1] ?? ts
            const sev = (log.severityText || "INFO").padEnd(5)
            const svc = log.serviceName
            const body = truncate(log.body, 100)
            lines.push(`  ${time} [${sev}] ${svc}: ${body}`)
          }
          if (logs.length > 20) {
            lines.push(`  ... and ${logs.length - 20} more logs`)
          }
        }

        const nextSteps: string[] = []
        const hasErrors = spans.some((s) => s.statusCode === "Error")
        if (hasErrors) {
          nextSteps.push(`\`search_logs trace_id="${trace_id}"\` — see all logs for this trace`)
        }
        if (serviceSet.size > 1) {
          for (const svc of [...serviceSet].slice(0, 2)) {
            nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate this service`)
          }
        }
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "inspect_trace",
            data: {
              traceId: trace_id,
              serviceCount: serviceSet.size,
              spanCount: spans.length,
              rootDurationMs: rootDuration,
              spans: roots,
              logs: logsResult.data.slice(0, 20).map((l) => ({
                timestamp: String(l.timestamp),
                severityText: l.severityText || "INFO",
                serviceName: l.serviceName,
                body: l.body,
                spanId: l.spanId,
              })),
            },
          }),
        }
      }),
  )
}
