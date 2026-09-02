import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AiSessionTooLargeError,
	AI_SESSION_SPANS_MAX_SPANS,
	AI_SESSION_SUMMARY_MAX_TURNS,
	CurrentTenant,
	GetAiSessionSpansResponse,
	GetAiSessionSummaryResponse,
	ListAiSessionsFacetsResponse,
	ListAiSessionsResponse,
	MapleInternalApi,
	MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
	type AiSessionTokenReporting,
	type AiSessionTokenTotals,
	type AiSessionTurnSummary,
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

			/**
			 * The window a session read is bounded by, and how the session is keyed.
			 *
			 * A `trace:<TraceId>` id is Maple's own: the vendor exposed no session
			 * key, so the trace IS the session and the reads key on the trace id
			 * instead of the session attribute. The helper returns `undefined` for
			 * a vendor id AND for a prefixed one that is not 32 hex characters, so a
			 * forged value never reaches the trace-keyed param — it takes the
			 * session path, where nothing carries it and the caller gets the
			 * empty-session answer.
			 *
			 * Both halves of the hint or neither: a lone bound would silently pin
			 * the other end of the read to the param placeholder. Without a hint
			 * the bounds are resolved from the id first, because every read has to
			 * be partition-pruned on both levels rather than fan out unpruned — see
			 * `aiSessionSpansQuery`. One extra round trip, and only on the
			 * deep-link path; `window_source` is how often that runs gets watched.
			 */
			const resolveRead = Effect.fn("aiSessions.resolveRead")(function* (payload: {
				readonly sessionId: string
				readonly startTime?: string
				readonly endTime?: string
			}) {
				const tenant = yield* CurrentTenant.Context
				const hint =
					payload.startTime !== undefined && payload.endTime !== undefined
						? { startTime: payload.startTime, endTime: payload.endTime }
						: undefined
				const traceId = traceSessionTraceId(payload.sessionId)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.ai.session.id": payload.sessionId,
					"maple.ai.session.kind": traceId === undefined ? "vendor" : "trace",
					"maple.ai.window_source": hint === undefined ? "resolved" : "client",
				})
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
				return { tenant, traceId, window }
			})

			return handlers
				.handle("list", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const compiled = CH.compile(
							Integrations.aiSessionListQuery({
								limit: payload.limit,
								offset: payload.offset,
								vendorIds: payload.vendorIds,
								serviceNames: payload.serviceNames,
							}),
							{
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
							},
						)
						// The row schema already coerces the UInt64 aggregates and decodes
						// exactly the response's fields, so rows pass through unmapped.
						const rows = yield* warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "listAiSessions",
						})
						return new ListAiSessionsResponse({ data: rows })
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
						// One UNION ALL result carrying both dimensions, split by facetType.
						const pick = (facetType: string) =>
							rows
								.filter((row) => row.facetType === facetType)
								.map((row) => ({ name: row.name, count: row.count }))
						return new ListAiSessionsFacetsResponse({
							vendors: pick("vendor"),
							services: pick("service"),
						})
					}),
				)
				.handle("spans", ({ payload }) =>
					Effect.gen(function* () {
						// Annotated before the read: a 413 never reaches the code below.
						const { tenant, traceId, window } = yield* resolveRead(payload)
						if (window === undefined) {
							return new GetAiSessionSpansResponse({ data: [] })
						}
						const limit = payload.limit ?? AI_SESSION_SPANS_MAX_SPANS
						// One row past the page: the extra row is what distinguishes a
						// session that exactly fills the page from one with a page after.
						const opts = {
							limit: limit + 1,
							scope: payload.scope,
							after: payload.after,
						}
						const rowSchema = { rowSchema: Integrations.aiSessionSpansRowSchema }
						const compiled =
							payload.traceIds !== undefined
								? CH.compile(
										Integrations.aiTraceSpansQuery({ ...opts, traceIds: payload.traceIds }),
										{ orgId: tenant.orgId, ...window },
										rowSchema,
									)
								: traceId === undefined
									? CH.compile(
											Integrations.aiSessionSpansQuery(opts),
											{ orgId: tenant.orgId, sessionId: payload.sessionId, ...window },
											rowSchema,
										)
									: CH.compile(
											Integrations.aiTraceSpansQuery(opts),
											{ orgId: tenant.orgId, traceId, ...window },
											rowSchema,
										)
						const rows = yield* warehouse
							.compiledQueryBounded(tenant, compiled, {
								profile: "list",
								context:
									payload.traceIds !== undefined
										? "aiTracesSpans"
										: traceId === undefined
											? "aiSessionSpans"
											: "aiTraceSpans",
								responseLimits: {
									maxRows: limit + 1,
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
						const page = rows.slice(0, limit)
						const last = page[page.length - 1]
						const nextCursor =
							rows.length > limit && last !== undefined
								? { timestamp: last.timestamp, spanId: last.spanId }
								: undefined
						yield* Effect.annotateCurrentSpan({
							"maple.ai.span_count": page.length,
							"maple.ai.scope": payload.scope ?? "all",
							"maple.ai.has_more": nextCursor !== undefined,
						})
						// Mapped server-side: the raw attribute map is the dominant weight
						// of this read and nothing downstream needs it.
						return new GetAiSessionSpansResponse({
							data: Integrations.mapAiSpans(page),
							...(nextCursor !== undefined && { nextCursor }),
						})
					}),
				)
				.handle("summary", ({ payload }) =>
					Effect.gen(function* () {
						const { tenant, traceId, window } = yield* resolveRead(payload)
						if (window === undefined) {
							return emptySummary()
						}
						// Two reads over the same spans, side by side: the turn rows are
						// capped, and a session grouping into more turns than the cap
						// must still report exact totals — those come from the ungrouped
						// read, which no cap touches.
						const params =
							traceId === undefined
								? { orgId: tenant.orgId, sessionId: payload.sessionId, ...window }
								: { orgId: tenant.orgId, traceId, ...window }
						const turnsQuery =
							traceId === undefined
								? Integrations.aiSessionSummaryQuery()
								: Integrations.aiTraceSummaryQuery()
						const totalsQuery =
							traceId === undefined ? Integrations.aiSessionTotalsQuery() : Integrations.aiTraceTotalsQuery()
						const kind = traceId === undefined ? "aiSession" : "aiTrace"
						const [rows, totals] = yield* Effect.all(
							[
								warehouse.compiledQuery(
									tenant,
									CH.compile(turnsQuery, params, { rowSchema: Integrations.aiSessionSummaryRowSchema }),
									{ context: `${kind}Summary` },
								),
								warehouse.compiledQuery(
									tenant,
									CH.compile(totalsQuery, params, { rowSchema: Integrations.aiSessionTotalsRowSchema }),
									{ context: `${kind}Totals` },
								),
							],
							{ concurrency: 2 },
						)
						const summary = foldSummary(totals[0], rows)
						yield* Effect.annotateCurrentSpan({
							"maple.ai.span_count": summary.spanCount,
							"maple.ai.turn_count": summary.turns.length,
						})
						return summary
					}),
				)
		}),
)

const NO_TOKENS: AiSessionTokenTotals = { input: 0, output: 0, cacheRead: 0 }

const emptySummary = () =>
	new GetAiSessionSummaryResponse({
		spanCount: 0,
		aiSpanCount: 0,
		traceCount: 0,
		durationMs: 0,
		llmCalls: 0,
		toolCalls: 0,
		errorSpanCount: 0,
		tokens: NO_TOKENS,
		tokenReporting: "none",
		models: [],
		agentNames: [],
		turns: [],
		turnsTruncated: false,
	})

/**
 * A set of spans' usage under the deepest-reporter rule: the model-call spans'
 * figures when any model call reported, the plain sum otherwise. See
 * `summaryMeasures` in the query module for why it returns both. Applied to
 * the session's own row for the totals, and to each turn row for the turn —
 * never to the turn rows summed, since a turn span's roll-up and its model
 * calls can land in different rows.
 */
const usageOf = (row: Integrations.AiSessionTotalsOutput | Integrations.AiSessionSummaryOutput) => {
	const perCall = row.llmInputTokens + row.llmOutputTokens + row.llmCacheReadTokens > 0
	const reporting: AiSessionTokenReporting =
		perCall ? "per-call" : row.inputTokens + row.outputTokens + row.cacheReadTokens > 0 ? "roll-up" : "none"
	const tokens: AiSessionTokenTotals = perCall
		? { input: row.llmInputTokens, output: row.llmOutputTokens, cacheRead: row.llmCacheReadTokens }
		: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens }
	// Cost follows the same rule, but only once something reported one: a
	// per-call session whose calls carry no price still has a session cost if
	// the wrapper stamped one.
	const cost =
		row.costReporters === 0 ? undefined : perCall && row.llmCost > 0 ? row.llmCost : row.cost
	return { reporting, tokens, cost }
}

/** The session's row and its turn rows, as the response shape. */
const foldSummary = (
	totals: Integrations.AiSessionTotalsOutput | undefined,
	rows: readonly Integrations.AiSessionSummaryOutput[],
) => {
	// An aggregate over no rows still yields one row, with a zero count.
	if (totals === undefined || totals.spanCount === 0) return emptySummary()
	const turnsTruncated = rows.length > AI_SESSION_SUMMARY_MAX_TURNS
	const kept = rows.slice(0, AI_SESSION_SUMMARY_MAX_TURNS)
	const usage = usageOf(totals)

	const turns: AiSessionTurnSummary[] = kept.map((row) => {
		const usage = usageOf(row)
		return {
			turnKey: row.turnKey,
			conversationId: row.conversationId,
			traceIds: row.traceIds,
			startTime: row.startTime,
			endTime: row.endTime,
			durationMs: row.durationMs,
			spanCount: row.spanCount,
			aiSpanCount: row.aiSpanCount,
			llmCalls: row.llmCalls,
			toolCalls: row.toolCalls,
			errorSpanCount: row.errorSpanCount,
			tokens: usage.tokens,
			...(usage.cost !== undefined && { cost: usage.cost }),
			models: row.models,
			agentNames: row.agentNames,
		}
	})
	return new GetAiSessionSummaryResponse({
		spanCount: totals.spanCount,
		aiSpanCount: totals.aiSpanCount,
		traceCount: totals.traceCount,
		startTime: totals.startTime,
		endTime: totals.endTime,
		durationMs: totals.durationMs,
		llmCalls: totals.llmCalls,
		toolCalls: totals.toolCalls,
		errorSpanCount: totals.errorSpanCount,
		tokens: usage.tokens,
		tokenReporting: usage.reporting,
		...(usage.cost !== undefined && { cost: usage.cost }),
		models: totals.models,
		agentNames: totals.agentNames,
		turns,
		turnsTruncated,
	})
}
