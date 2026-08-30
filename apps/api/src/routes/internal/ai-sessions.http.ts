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
import { isMissingAiTraceIndex } from "@/services/warehouse/missing-table"
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
/**
 * Empty result instead of a 502 when `ai_trace_index` is absent — it ships in
 * a `requiredForIngest: false` migration, so a BYO-ClickHouse cluster gains it
 * only when an admin applies migration 0023, and nothing reconciles that (see
 * `missing-table.ts`). Never silently, though: an empty page is otherwise
 * indistinguishable from "no agent traces", which is exactly the 0-row blind
 * spot the rollups doc warns about — the warning and the span flag are the
 * difference. Same log/annotation shape as `makeRollupFallback`, and a plain
 * helper rather than `Effect.fn` for the same reason: the annotation must land
 * on the handler's own span.
 */
const emptyWhenIndexMissing =
	(orgId: string) =>
	<A, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>): Effect.Effect<ReadonlyArray<A>, E, R> =>
		effect.pipe(
			Effect.catch((error) => {
				if (!isMissingAiTraceIndex(error)) return Effect.fail(error)
				return Effect.gen(function* () {
					yield* Effect.logWarning(
						"ai_trace_index is absent on this cluster; serving an empty agent-sessions response. Apply ClickHouse schema to restore the read.",
					).pipe(Effect.annotateLogs({ orgId }))
					yield* Effect.annotateCurrentSpan("query.rollup.fallback", true)
					return [] as ReadonlyArray<A>
				})
			}),
		)

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
						const compiled = CH.compile(
							Integrations.aiSessionListQuery({
								limit: payload.limit,
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
						const rows = yield* warehouse
							.compiledQuery(tenant, compiled, {
								profile: "list",
								context: "listAiSessions",
							})
							.pipe(emptyWhenIndexMissing(tenant.orgId))
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
						const rows = yield* warehouse
							.compiledQuery(tenant, compiled, {
								profile: "list",
								context: "aiSessionsFacets",
							})
							.pipe(emptyWhenIndexMissing(tenant.orgId))
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
