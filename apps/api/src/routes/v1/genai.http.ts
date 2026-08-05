import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	AGENT_TRACE_DETAIL_WINDOW_MS,
	AGENT_TRACE_TIMELINE_SPAN_CAP,
	AgentTraceFacetsResponse,
	AgentTraceSummaryResponse,
	AgentTraceTimelineResponse,
	ListAgentTracesResponse,
	MapleApi,
} from "@maple/domain/http"
import { Clock, Effect } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

// ---------------------------------------------------------------------------
// Agent Traces read API
//
// Four endpoints over the derived-agent trace queries in `@maple/query-engine/ch`.
// No datasource of its own: an agent trace is `traces` rows grouped by an `AgentTraceId`
// derived at query time (`gen_ai.conversation.id` → `session.id` → `TraceId`).
//
// Three things this layer owns, because every client would otherwise redo them:
//
//   - the **title ladder** (first user message → agent → model → id),
//   - **cost presence** (no cost attribute ⇒ `null`, never `0`),
//   - the **cumulative-input dedupe** and tool-call nesting (`buildAgentTraceTimeline`).
// ---------------------------------------------------------------------------

const warehouseDateTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max)}…`)

/**
 * The first *user* message of the agent trace, from the earliest span's (cumulative)
 * `gen_ai.input.messages`.
 *
 * Returns `null` — not `""` — when there is none, which is the common case:
 * privacy modes strip exactly this. The row then falls back to agent → model →
 * agent trace id client-side, so no row ever renders as blank.
 */
const deriveTitle = (titleSource: string): string | null => {
	const messages = CH.parseGenAiMessages(titleSource, "user")
	const firstUser = messages.find((m) => m.role === "user" && m.text !== "")
	const fallback = messages.find((m) => m.text !== "")
	const text = (firstUser ?? fallback)?.text
	return text === undefined || text === "" ? null : truncate(text.trim(), 160)
}

/**
 * Numbers arrive already decoded — `agentTraceListRowSchema` runs every aggregate
 * through `CH.CHNumber`, which accepts both the quoted and unquoted 64-bit wire
 * shapes. Re-coercing with `Number(...)` here would only hide a future drift as
 * `NaN` instead of failing the decode with a tagged error.
 */
const toListItem = (row: CH.AgentTraceListOutput) => ({
	agentTraceId: row.agentTraceId,
	title: deriveTitle(row.titleSource),
	startTime: row.startTime,
	endTime: row.endTime,
	durationMs: row.durationMs,
	turnCount: row.turnCount,
	toolCallCount: row.toolCallCount,
	toolErrorCount: row.toolErrorCount,
	errorCount: row.errorCount,
	spanCount: row.spanCount,
	traceCount: row.traceCount,
	inputTokens: row.inputTokens,
	outputTokens: row.outputTokens,
	totalTokens: row.totalTokens,
	cachedInputTokens: row.cachedInputTokens,
	reasoningTokens: row.reasoningTokens,
	// Presence, not magnitude, decides null: an agent trace whose emitter never sent
	// a cost is unknown-cost, and the header omits the stat instead of $0.00.
	cost: row.costSpanCount > 0 ? row.cost : null,
	models: row.models,
	requestedModels: row.requestedModels,
	providers: row.providers,
	agents: row.agents,
	workflowName: row.workflowName,
	finishReasons: row.finishReasons,
	serviceName: row.serviceName,
	// Error wins over running: an agent trace that already failed is not "in progress"
	// just because a span landed a minute ago. Same precedence as the SQL filter.
	status:
		row.errorCount > 0
			? ("error" as const)
			: row.isRunning === 1
				? ("running" as const)
				: ("ok" as const),
	contentRedacted: row.contentSpanCount === 0,
	contentInEvents: row.contentSpanCount === 0 && row.contentEventSpanCount > 0,
})

export const HttpGenAiAgentTracesLive = HttpApiBuilder.group(MapleApi, "genaiAgentTraces", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		return handlers
			.handle("listAgentTraces", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compile(
						CH.agentTraceListQuery({
							model: payload.model,
							requestedModel: payload.requestedModel,
							provider: payload.provider,
							agent: payload.agent,
							workflow: payload.workflow,
							serviceName: payload.serviceName,
							status: payload.status,
							finishReason: payload.finishReason,
							hasTools: payload.hasTools,
							contentRedacted: payload.contentRedacted,
							search: payload.search,
							durationMinMs: payload.durationMinMs,
							durationMaxMs: payload.durationMaxMs,
							turnMin: payload.turnMin,
							turnMax: payload.turnMax,
							tokenMin: payload.tokenMin,
							tokenMax: payload.tokenMax,
							costMin: payload.costMin,
							costMax: payload.costMax,
							sort: payload.sort,
							sortDirection: payload.sortDirection,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
						{ rowSchema: CH.agentTraceListRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "listAgentTraces",
					})
					return new ListAgentTracesResponse({ data: rows.map(toListItem) })
				}),
			)
			.handle("facets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compileUnion(
						CH.agentTraceFacetsQuery({
							model: payload.model,
							requestedModel: payload.requestedModel,
							provider: payload.provider,
							agent: payload.agent,
							workflow: payload.workflow,
							serviceName: payload.serviceName,
							status: payload.status,
							finishReason: payload.finishReason,
							hasTools: payload.hasTools,
							contentRedacted: payload.contentRedacted,
							search: payload.search,
							durationMinMs: payload.durationMinMs,
							durationMaxMs: payload.durationMaxMs,
							turnMin: payload.turnMin,
							turnMax: payload.turnMax,
							tokenMin: payload.tokenMin,
							tokenMax: payload.tokenMax,
							costMin: payload.costMin,
							costMax: payload.costMax,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
						{ rowSchema: CH.agentTraceFacetsRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "agentTraceFacets",
					})
					// Counts arrive decoded: the query declares `agentTraceFacetsRowSchema`,
					// whose `CH.CHNumber` accepts both wire shapes (ClickHouse quotes
					// 64-bit aggregates as JSON strings, Tinybird returns numbers). A
					// `Number(...)` at the edge would turn any future drift into a
					// silent NaN instead of a tagged decode failure.
					const pick = (facetType: string) =>
						rows
							.filter((row) => row.facetType === facetType)
							.map((row) => ({ name: row.name, count: row.count }))
					const stat = (facetType: string, name: string) =>
						rows.find((r) => r.facetType === facetType && r.name === name)?.count ?? 0
					const toggle = (facetType: string) =>
						rows.find((r) => r.facetType === facetType)?.count ?? 0
					return new AgentTraceFacetsResponse({
						models: pick("model"),
						providers: pick("provider"),
						agents: pick("agent"),
						workflows: pick("workflow"),
						services: pick("service"),
						finishReasons: pick("finishReason"),
						statuses: pick("status"),
						toolCount: toggle("tools"),
						redactedCount: toggle("redacted"),
						durationBuckets: pick("durationBucket"),
						durationP50: stat("durationStat", "p50"),
						durationP95: stat("durationStat", "p95"),
						turnP50: stat("turnStat", "p50"),
						turnP95: stat("turnStat", "p95"),
						tokenP50: stat("tokenStat", "p50"),
						tokenP95: stat("tokenStat", "p95"),
						// Carried as micro-dollars so the UNION's integer count column
						// doesn't round a $0.004 p95 to zero.
						costP50: stat("costStat", "p50") / 1_000_000,
						costP95: stat("costStat", "p95") / 1_000_000,
					})
				}),
			)
			.handle("agentTraceSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.agent_trace.id": payload.agentTraceId,
					})
					const now = yield* Clock.currentTimeMillis
					const startTime = payload.startTime ?? warehouseDateTime(now - AGENT_TRACE_DETAIL_WINDOW_MS)
					const endTime = payload.endTime ?? warehouseDateTime(now)
					const compiled = CH.compile(
						CH.agentTraceSummaryQuery(),
						{ orgId: tenant.orgId, startTime, endTime, agentTraceId: payload.agentTraceId },
						{ rowSchema: CH.agentTraceSummaryRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "aggregation",
						context: "agentTraceSummary",
					})
					const row = rows[0]
					return new AgentTraceSummaryResponse({ data: row ? toListItem(row) : null })
				}),
			)
			.handle("agentTraceTimeline", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.agent_trace.id": payload.agentTraceId,
					})
					const now = yield* Clock.currentTimeMillis
					const startTime = payload.startTime ?? warehouseDateTime(now - AGENT_TRACE_DETAIL_WINDOW_MS)
					const endTime = payload.endTime ?? warehouseDateTime(now)
					const limit = Math.min(
						payload.limit ?? AGENT_TRACE_TIMELINE_SPAN_CAP,
						AGENT_TRACE_TIMELINE_SPAN_CAP,
					)
					const compiled = CH.compile(
						CH.agentTraceTimelineQuery({ limit, offset: payload.offset }),
						{ orgId: tenant.orgId, startTime, endTime, agentTraceId: payload.agentTraceId },
						{ rowSchema: CH.agentTraceTimelineRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "agentTraceTimeline",
					})
					// Cumulative-input dedupe + tool-call nesting happen here, once,
					// rather than in every client that reads an agent trace. It is a
					// multi-megabyte JSON.parse over every message-bearing span, so it
					// gets its own span — otherwise a slow agent trace detail looks like a
					// slow warehouse query and the CPU time is invisible.
					const events = yield* Effect.sync(() => CH.buildAgentTraceTimeline(rows)).pipe(
						Effect.withSpan("buildAgentTraceTimeline", {
							attributes: {
								"maple.agent_trace.id": payload.agentTraceId,
								"maple.agentTrace.span_count": rows.length,
							},
						}),
					)
					yield* Effect.annotateCurrentSpan({
						"maple.agentTrace.span_count": rows.length,
						"maple.agentTrace.event_count": events.length,
						"maple.agentTrace.truncated": rows.length >= limit,
					})
					return new AgentTraceTimelineResponse({
						events,
						spanCount: rows.length,
						truncated: rows.length >= limit,
					})
				}),
			)
	}),
)
