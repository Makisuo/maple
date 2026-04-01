import {
  requiredStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { withTenantExecutor } from "../lib/query-tinybird"
import { formatDurationFromMs, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "../lib/structured-output"
import { inspectTrace, type SpanNode } from "@maple/query-engine/observability"

export function registerInspectTraceTool(server: McpToolRegistrar) {
  server.tool(
    "inspect_trace",
    "Get the full span tree and logs for a single trace. Use this to understand request flow, find bottlenecks, and see error context.",
    Schema.Struct({
      trace_id: requiredStringParam("The trace ID to inspect"),
    }),
    Effect.fn("McpTool.inspectTrace")(function* ({ trace_id }) {
        yield* Effect.annotateCurrentSpan("traceId", trace_id)

        const result = yield* withTenantExecutor(inspectTrace(trace_id)).pipe(
          Effect.catchTag("@maple/query-engine/errors/ObservabilityError", (e) =>
            Effect.fail(new McpQueryError({ message: e.message, pipe: e.pipe ?? "span_hierarchy", cause: e })),
          ),
        )

        if (result.spanCount === 0) {
          return { content: [{ type: "text" as const, text: `No spans found for trace ${trace_id}` }] }
        }

        const lines: string[] = [
          `## Trace ${trace_id} (${result.serviceCount} services, ${result.spanCount} spans, ${formatDurationFromMs(result.rootDurationMs)})`,
          ``,
        ]

        const renderNode = (node: SpanNode, prefix: string, isLast: boolean): void => {
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
            const attrStr = pipe(attrEntries, Arr.take(5), Arr.map(([k, v]) => `${k}=${truncate(String(v), 60)}`)).join(", ")
            lines.push(`${detailPrefix}    {${attrStr}}`)
          }
          const resAttrEntries = Object.entries(node.resourceAttributes)
          if (resAttrEntries.length > 0) {
            const resAttrStr = pipe(resAttrEntries, Arr.take(5), Arr.map(([k, v]) => `${k}=${truncate(String(v), 60)}`)).join(", ")
            lines.push(`${detailPrefix}    resource: {${resAttrStr}}`)
          }
          const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
          Arr.forEach(node.children, (child, i) => {
            renderNode(child, childPrefix, i === node.children.length - 1)
          })
        }

        Arr.forEach(result.spans, (root) => {
          renderNode(root, "", true)
        })

        if (result.logs.length > 0) {
          lines.push(``, `Related Logs (${result.logs.length}):`)
          Arr.forEach(result.logs, (log) => {
            const ts = log.timestamp
            const time = ts.split(" ")[1] ?? ts
            const sev = log.severityText.padEnd(5)
            lines.push(`  ${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 100)}`)
          })
        }

        const collectServices = (n: SpanNode): string[] =>
          [n.serviceName, ...Arr.flatMap(n.children, collectServices)]

        const services = pipe(
          result.spans,
          Arr.flatMap(collectServices),
          Arr.dedupe,
        )

        const nextSteps: string[] = []
        const hasErrors = Arr.some(result.spans, function checkError(n: SpanNode): boolean {
          return n.statusCode === "Error" || Arr.some(n.children, checkError)
        })
        if (hasErrors) {
          nextSteps.push(`\`search_logs trace_id="${trace_id}"\` — see all logs for this trace`)
        }
        Arr.forEach(Arr.take(services, 2), (svc) => {
          nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate this service`)
        })
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
              logs: pipe(result.logs, Arr.map((l) => ({ ...l }))),
            },
          }),
        }
      }),
  )
}
