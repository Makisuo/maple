import { Array as Arr, Effect, HashMap, HashSet, Option, Schema, pipe } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor } from "./TinybirdExecutor"
import type { InspectTraceOutput, SpanNode } from "./types"
import { toLogEntry } from "./row-mappers"

const SKIP_ATTR_PREFIXES = ["http.request.header.", "http.response.header.", "signoz."]
const SKIP_ATTR_KEYS = HashSet.fromIterable([
	"http.request.method",
	"url.scheme",
	"url.full",
	"url.path",
	"http.route",
	"http.response.status_code",
	"user_agent.original",
	"server.address",
	"server.port",
	"client.address",
])

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const extractKeyAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(
					([k, v]) =>
						v !== "" &&
						!HashSet.has(SKIP_ATTR_KEYS, k) &&
						!Arr.some(SKIP_ATTR_PREFIXES, (p) => k.startsWith(p)),
				),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

const parseJsonAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(([, v]) => v !== ""),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

type MutableSpanNode = SpanNode & { children: MutableSpanNode[] }

export const inspectTrace = Effect.fn("Observability.inspectTrace")(function* (traceId: string) {
	const executor = yield* TinybirdExecutor
	yield* Effect.annotateCurrentSpan("traceId", traceId)

	const [spansResult, logsResult] = yield* Effect.all(
		[
			executor.query<SpanHierarchyOutput>("span_hierarchy", { trace_id: traceId }, { profile: "list" }),
			executor.query<ListLogsOutput>(
				"list_logs",
				{ trace_id: traceId, limit: 50 },
				{ profile: "list" },
			),
		],
		{ concurrency: "unbounded" },
	)

	const spans = spansResult.data

	const nodes: MutableSpanNode[] = yield* Effect.forEach(spans, (span) =>
		Effect.gen(function* () {
			const attributes = yield* extractKeyAttributes(span.spanAttributes ?? "{}")
			const resourceAttributes = yield* parseJsonAttributes(span.resourceAttributes ?? "{}")
			const node: MutableSpanNode = {
				spanId: Schema.decodeSync(SpanId)(span.spanId),
				parentSpanId: span.parentSpanId,
				spanName: span.spanName,
				serviceName: span.serviceName,
				durationMs: span.durationMs,
				statusCode: span.statusCode,
				statusMessage: span.statusMessage,
				attributes,
				resourceAttributes,
				children: [],
			}
			return node
		}),
	)

	// Index by spanId (use string keys for parentSpanId lookup compatibility)
	const nodeMap = HashMap.fromIterable(
		pipe(
			nodes,
			Arr.map((n) => [n.spanId as string, n] as const),
		),
	)

	// Link children and collect roots
	const roots = pipe(
		nodes,
		Arr.filter((node) => {
			if (node.parentSpanId) {
				pipe(
					HashMap.get(nodeMap, node.parentSpanId),
					Option.map((parent) => {
						parent.children.push(node)
					}),
				)
				return !HashMap.has(nodeMap, node.parentSpanId)
			}
			return true
		}),
	)

	const serviceCount = pipe(
		spans,
		Arr.map((s) => s.serviceName),
		Arr.dedupe,
	).length

	yield* Effect.annotateCurrentSpan("spanCount", spans.length)
	yield* Effect.annotateCurrentSpan("serviceCount", serviceCount)

	return {
		traceId: Schema.decodeSync(TraceId)(traceId),
		serviceCount,
		spanCount: spans.length,
		rootDurationMs: roots[0]?.durationMs ?? 0,
		spans: roots,
		logs: pipe(logsResult.data, Arr.take(20), Arr.map(toLogEntry)),
	} satisfies InspectTraceOutput
})
