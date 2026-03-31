import { Array as Arr, Effect, HashMap, Option, pipe } from "effect"
import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { InspectTraceOutput, SpanNode } from "./types"
import { toLogEntry } from "./row-mappers"

const SKIP_ATTR_PREFIXES = ["http.request.header.", "http.response.header.", "signoz."]
const SKIP_ATTR_KEYS = new Set([
  "http.request.method", "url.scheme", "url.full", "url.path", "http.route",
  "http.response.status_code", "user_agent.original", "server.address",
  "server.port", "client.address",
])

const extractKeyAttributes = (raw: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return pipe(
      Object.entries(parsed),
      Arr.filter(([k, v]) =>
        v !== "" &&
        !SKIP_ATTR_KEYS.has(k) &&
        !SKIP_ATTR_PREFIXES.some((p) => k.startsWith(p)),
      ),
      Object.fromEntries,
    )
  } catch {
    return {}
  }
}

type MutableSpanNode = SpanNode & { children: MutableSpanNode[] }

export const inspectTrace = (
  traceId: string,
): Effect.Effect<InspectTraceOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const [spansResult, logsResult] = yield* Effect.all(
      [
        executor.query<SpanHierarchyOutput>("span_hierarchy", { trace_id: traceId }),
        executor.query<ListLogsOutput>("list_logs", { trace_id: traceId, limit: 50 }),
      ],
      { concurrency: "unbounded" },
    )

    const spans = spansResult.data

    // Build nodes
    const nodes: MutableSpanNode[] = pipe(
      spans,
      Arr.map((span): MutableSpanNode => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        spanName: span.spanName,
        serviceName: span.serviceName,
        durationMs: span.durationMs,
        statusCode: span.statusCode,
        statusMessage: span.statusMessage,
        attributes: extractKeyAttributes(span.spanAttributes ?? "{}"),
        children: [],
      })),
    )

    // Index by spanId
    const nodeMap = HashMap.fromIterable(
      pipe(nodes, Arr.map((n) => [n.spanId, n] as const)),
    )

    // Link children and collect roots
    const roots = pipe(
      nodes,
      Arr.filter((node) => {
        if (node.parentSpanId) {
          pipe(
            HashMap.get(nodeMap, node.parentSpanId),
            Option.map((parent) => { parent.children.push(node) }),
          )
          return !HashMap.has(nodeMap, node.parentSpanId)
        }
        return true
      }),
    )

    const serviceCount = pipe(spans, Arr.map((s) => s.serviceName), Arr.dedupe).length

    return {
      traceId,
      serviceCount,
      spanCount: spans.length,
      rootDurationMs: roots[0]?.durationMs ?? 0,
      spans: roots,
      logs: pipe(logsResult.data, Arr.take(20), Arr.map(toLogEntry)),
    }
  })
