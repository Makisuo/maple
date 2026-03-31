import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { InspectTraceOutput, SpanNode } from "./types"

const SKIP_ATTR_PREFIXES = ["http.request.header.", "http.response.header.", "signoz."]
const SKIP_ATTR_KEYS = new Set([
  "http.request.method", "url.scheme", "url.full", "url.path", "http.route",
  "http.response.status_code", "user_agent.original", "server.address",
  "server.port", "client.address",
])

function extractKeyAttributes(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || v === "") continue
      if (SKIP_ATTR_KEYS.has(k)) continue
      if (SKIP_ATTR_PREFIXES.some((p) => k.startsWith(p))) continue
      result[k] = String(v)
    }
    return result
  } catch {
    return {}
  }
}

export const inspectTrace = (
  traceId: string,
): Effect.Effect<InspectTraceOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const [spansResult, logsResult] = yield* Effect.all(
      [
        executor.query("span_hierarchy", { trace_id: traceId }),
        executor.query("list_logs", { trace_id: traceId, limit: 50 }),
      ],
      { concurrency: "unbounded" },
    )

    const spans = spansResult.data as any[]

    // Build span tree
    const nodeMap = new Map<string, SpanNode & { children: SpanNode[] }>()
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
        attributes: extractKeyAttributes(span.spanAttributes ?? "{}"),
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

    return {
      traceId,
      serviceCount: serviceSet.size,
      spanCount: spans.length,
      rootDurationMs: roots[0]?.durationMs ?? 0,
      spans: roots,
      logs: (logsResult.data as any[]).slice(0, 20).map((l) => ({
        timestamp: String(l.timestamp),
        severityText: l.severityText || "INFO",
        serviceName: l.serviceName,
        body: l.body,
        spanId: l.spanId ?? "",
      })),
    }
  })
