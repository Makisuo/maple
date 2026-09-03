import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AiSessionTooLargeError,
	AI_SESSION_SPANS_MAX_SPANS,
	CurrentTenant,
	GetAiSessionSpansResponse,
	ListAiSessionsFacetsResponse,
	ListAiSessionsResponse,
	MapleInternalApi,
	MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
} from "@maple/domain/http"
import { traceSessionTraceId } from "@maple/domain/gen-ai"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page (behind the `agent_tracing` org rollout flag).
 * The flag hides the surface, not the data — scoping is `CurrentTenant`, like
 * every other warehouse read.
 */
export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			return handlers
				.handle("list", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						// The counted filters go to BOTH stages, so they resolve a trace
						// identically; the session-level ones and the sort rank the page
						// and are the page's alone.
						const filters = {
							vendorIds: payload.vendorIds,
							serviceNames: payload.serviceNames,
							deploymentEnvs: payload.deploymentEnvs,
							models: payload.models,
							agentNames: payload.agentNames,
							toolNames: payload.toolNames,
							search: payload.search,
						}
						const window = {
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
						}
						// Two reads, not one: the page is ranked on `ai_trace_index` over the
						// caller's whole window, and only then is that page aggregated over
						// `trace_detail_spans` — inside the hours its own agent spans cover,
						// never the caller's window. See `aiSessionListQuery` for what the
						// single-read shape cost.
						const page = yield* warehouse.compiledQuery(
							tenant,
							CH.compile(
								Integrations.aiSessionPageQuery({
									...filters,
									limit: payload.limit,
									offset: payload.offset,
									hasErrors: payload.hasErrors,
									excludeTraceSessions: payload.excludeTraceSessions,
									durationMinMs: payload.durationMinMs,
									durationMaxMs: payload.durationMaxMs,
									costMin: payload.costMin,
									costMax: payload.costMax,
									tokensMin: payload.tokensMin,
									tokensMax: payload.tokensMax,
									llmCallsMin: payload.llmCallsMin,
									llmCallsMax: payload.llmCallsMax,
									toolCallsMin: payload.toolCallsMin,
									toolCallsMax: payload.toolCallsMax,
									sortBy: payload.sortBy,
									sortDir: payload.sortDir,
								}),
								window,
							),
							{ profile: "list", context: "aiSessionsPage" },
						)
						if (page.length === 0) {
							return new ListAiSessionsResponse({ data: [] })
						}
						// Fixed-width warehouse literals, so they sort as the instants do.
						const fanOutStart = page
							.map((row) => row.agentStart)
							.reduce((a, b) => (a < b ? a : b))
						const fanOutEnd = page.map((row) => row.agentEnd).reduce((a, b) => (a < b ? b : a))
						// The row schema already coerces the UInt64 aggregates and decodes
						// exactly the response's fields, so rows pass through unmapped.
						const rows = yield* warehouse.compiledQuery(
							tenant,
							CH.compile(
								Integrations.aiSessionListQuery({
									...filters,
									sessionIds: page.map((row) => row.sessionId),
								}),
								{ orgId: tenant.orgId, fanOutStart, fanOutEnd },
							),
							{ profile: "list", context: "listAiSessions" },
						)
						// The page's order is the order that was paged, so it is the order
						// shown: the aggregation sorts by the true first span, which leads
						// the first agent span the page ranked on by under a second.
						//
						// A session the aggregation did not return is dropped rather than
						// shown blank, and `ranked` tells the client the page was still a
						// full one. It happens: `ai_trace_index` and `trace_detail_spans`
						// are two materialized views written one after the other from the
						// same `traces` insert, so the newest session — ranked first — can
						// have index rows a moment before it has span rows, and at the far
						// end of retention the two tables' TTL merges run on their own
						// clocks. The two counts on the span are how often.
						yield* Effect.annotateCurrentSpan({
							"maple.ai.page_size": page.length,
							"maple.ai.aggregated": rows.length,
						})
						// One row per session: the fan-out's facts (spans, services, the
						// true extent, the all-span error count) joined with the page's
						// measures (models, agents, calls, usage), which only the index
						// can answer and the page already computed to rank on.
						const byId = new Map(rows.map((row) => [row.sessionId, row]))
						return new ListAiSessionsResponse({
							data: page.flatMap((ranked) => {
								const row = byId.get(ranked.sessionId)
								if (row === undefined) return []
								return {
									...row,
									models: ranked.models,
									agentNames: ranked.agentNames,
									llmCalls: ranked.llmCalls,
									toolCalls: ranked.toolCalls,
									totalTokens: ranked.totalTokens,
									cost: ranked.cost,
								}
							}),
							ranked: page.length,
						})
					}),
				)
				.handle("facets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const compiled = CH.compileUnion(Integrations.aiSessionFacetsQuery(), {
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
						})
						const rows = yield* warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "aiSessionsFacets",
						})
						// One UNION ALL result carrying every dimension, split by facetType.
						const pick = (facetType: Integrations.AiSessionFacetType) =>
							rows
								.filter((row) => row.facetType === facetType)
								.map((row) => ({ name: row.name, count: row.count }))
						return new ListAiSessionsFacetsResponse({
							vendors: pick("vendor"),
							services: pick("service"),
							environments: pick("environment"),
							models: pick("model"),
							agents: pick("agent"),
							tools: pick("tool"),
						})
					}),
				)
				.handle("spans", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Both halves or neither: a lone bound would silently pin the
						// other end of the read to the param placeholder.
						const hint =
							payload.startTime !== undefined && payload.endTime !== undefined
								? { startTime: payload.startTime, endTime: payload.endTime }
								: undefined
						// A `trace:<TraceId>` id is Maple's own: the vendor exposed no
						// session key, so the trace IS the session and both reads key on
						// the trace id instead of the session attribute. The helper
						// returns `undefined` for a vendor id AND for a prefixed one that
						// is not 32 hex characters, so a forged value never reaches the
						// trace-keyed param — it takes the session path, where nothing
						// carries it and the caller gets the empty-session answer below.
						const traceId = traceSessionTraceId(payload.sessionId)
						// Annotated before the read: a 413 never reaches the code below.
						// `window_source` is how often the extra resolve round-trip runs
						// gets watched — it should stay the exception.
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.ai.session.id": payload.sessionId,
							"maple.ai.session.kind": traceId === undefined ? "vendor" : "trace",
							"maple.ai.window_source": hint === undefined ? "resolved" : "client",
						})
						// The spans read has to be partition-pruned on both levels, so a
						// caller without bounds gets bounds first rather than an unpruned
						// fan-out — see `aiSessionSpansQuery`. One extra round trip, and
						// only on the deep-link path.
						const resolved =
							hint !== undefined
								? undefined
								: traceId === undefined
									? yield* warehouse.compiledQuery(
											tenant,
											CH.compile(Integrations.aiSessionWindowQuery(), {
												orgId: tenant.orgId,
												sessionId: payload.sessionId,
											}),
											{ profile: "list", context: "aiSessionWindow" },
										)
									: yield* warehouse.compiledQuery(
											tenant,
											CH.compile(Integrations.aiTraceWindowQuery(), {
												orgId: tenant.orgId,
												traceId,
											}),
											{ profile: "list", context: "aiTraceWindow" },
										)
						// `min`/`max` over no rows return the epoch rather than nothing, so
						// the count is what distinguishes an unknown session id.
						const bounds = resolved?.[0]
						const window =
							hint ??
							(bounds !== undefined && bounds.spanCount > 0
								? { startTime: bounds.startTime, endTime: bounds.endTime }
								: undefined)
						if (window === undefined) {
							return new GetAiSessionSpansResponse({ data: [], truncated: false })
						}
						// One row past the cap: the extra row is what distinguishes a
						// session that exactly fills the cap from one whose tail was cut.
						const compiled =
							traceId === undefined
								? CH.compile(
										Integrations.aiSessionSpansQuery({
											limit: AI_SESSION_SPANS_MAX_SPANS + 1,
										}),
										{ orgId: tenant.orgId, sessionId: payload.sessionId, ...window },
										{ rowSchema: Integrations.aiSessionSpansRowSchema },
									)
								: CH.compile(
										Integrations.aiTraceSpansQuery({
											limit: AI_SESSION_SPANS_MAX_SPANS + 1,
										}),
										{ orgId: tenant.orgId, traceId, ...window },
										{ rowSchema: Integrations.aiSessionSpansRowSchema },
									)
						const rows = yield* warehouse
							.compiledQueryBounded(tenant, compiled, {
								profile: "list",
								context: traceId === undefined ? "aiSessionSpans" : "aiTraceSpans",
								responseLimits: {
									maxRows: AI_SESSION_SPANS_MAX_SPANS + 1,
									maxBytes: MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
								},
							})
							.pipe(
								Effect.catchTag(
									"@maple/query-engine/execution/WarehouseResponseLimitError",
									() =>
										Effect.fail(
											new AiSessionTooLargeError({
												sessionId: payload.sessionId,
												message: "AI session spans exceeded the response byte limit.",
											}),
										),
								),
							)
						const truncated = rows.length > AI_SESSION_SPANS_MAX_SPANS
						const spans = rows.slice(0, AI_SESSION_SPANS_MAX_SPANS)
						yield* Effect.annotateCurrentSpan({
							"maple.ai.span_count": spans.length,
							"maple.ai.truncated": truncated,
						})
						// Mapped server-side: the raw attribute maps are the dominant
						// weight of this read and nothing downstream needs them.
						return new GetAiSessionSpansResponse({
							data: Integrations.mapAiSpans(spans),
							truncated,
						})
					}),
				)
		}),
)
