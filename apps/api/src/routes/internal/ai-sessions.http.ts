import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AiSessionTooLargeError,
	CurrentTenant,
	GetAiSessionSpansResponse,
	ListAiSessionsFacetsResponse,
	ListAiSessionsResponse,
	MapleInternalApi,
	MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
} from "@maple/domain/http"
import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

// The wire span shape is declared in `@maple/domain` and the mapped one in
// `@maple/query-engine-integrations`, because the integrations package depends
// on the domain and cannot be imported back from it. This is the only place
// both are visible, so it is where the claim that they are the same shape gets
// enforced.
type Assert<T extends true> = T
type NoExtraKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never] ? true : false

// Assignability alone would pass a wire struct missing a `gen_ai` field —
// every one of them is optional, so a dropped key satisfies both directions.
// The key sets are compared as well, which is the drift that actually happens:
// a field added to the catalog and not to the wire would silently stop being
// sent. Together they cover both the names and the value types.
type _MappedSpanMatchesWireSpan = Assert<
	Integrations.AiAgentSpan extends AiSessionSpan
		? AiSessionSpan extends Integrations.AiAgentSpan
			? true
			: false
		: false
>
type _WireCarriesEveryCatalogField = Assert<NoExtraKeys<Integrations.AiGenAiValues, AiSessionGenAiValues>>
type _WireInventsNoField = Assert<NoExtraKeys<AiSessionGenAiValues, Integrations.AiGenAiValues>>

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
						const compiled = CH.compile(
							Integrations.aiSessionListQuery({
								limit: payload.limit,
								vendorIds: payload.vendorIds,
								serviceNames: payload.serviceNames,
							}),
							{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
							{ rowSchema: Integrations.aiSessionListRowSchema },
						)
						// The row schema already coerces the UInt64 aggregates and decodes
						// exactly the response's fields, so rows pass through unmapped
						// (unlike listReplays, which re-brands and re-coerces per field).
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
						const compiled = CH.compileUnion(
							Integrations.aiSessionFacetsQuery(),
							{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
							{ rowSchema: Integrations.aiSessionFacetsRowSchema },
						)
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
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						// One row past the cap: the extra row is what distinguishes a
						// session that exactly fills the cap from one whose tail was cut.
						const compiled = CH.compile(
							Integrations.aiSessionSpansQuery({
								limit: Integrations.AI_SESSION_SPANS_MAX_SPANS + 1,
							}),
							{
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
								sessionId: payload.sessionId,
							},
							{ rowSchema: Integrations.aiSessionSpansRowSchema },
						)
						const rows = yield* warehouse
							.compiledQueryBounded(tenant, compiled, {
								profile: "list",
								context: "aiSessionSpans",
								responseLimits: {
									maxRows: Integrations.AI_SESSION_SPANS_MAX_SPANS + 1,
									maxBytes: MAX_AI_SESSION_SPANS_RESPONSE_BYTES,
								},
							})
							.pipe(
								Effect.catchTag(
									"@maple/query-engine/execution/WarehouseResponseLimitError",
									(error) =>
										Effect.fail(
											new AiSessionTooLargeError({
												sessionId: payload.sessionId,
												message: `AI session spans exceeded the ${error.kind} response limit.`,
											}),
										),
								),
							)
						// Mapped server-side: the raw attribute maps are the dominant
						// weight of this read and nothing downstream needs them.
						return new GetAiSessionSpansResponse({
							data: Integrations.mapAiSpans(
								rows.slice(0, Integrations.AI_SESSION_SPANS_MAX_SPANS),
							),
							truncated: rows.length > Integrations.AI_SESSION_SPANS_MAX_SPANS,
						})
					}),
				)
		}),
)
