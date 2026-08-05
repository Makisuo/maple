import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	JOURNEY_DETAIL_WINDOW_MS,
	JOURNEY_TIMELINE_SPAN_CAP,
	JourneyFacetsResponse,
	JourneySummaryResponse,
	JourneyTimelineResponse,
	ListJourneysResponse,
	MapleApi,
} from "@maple/domain/http"
import { Clock, Effect } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

// ---------------------------------------------------------------------------
// Agentic Journeys read API
//
// Four endpoints over the derived-journey queries in `@maple/query-engine/ch`.
// No datasource of its own: a journey is `traces` rows grouped by a `JourneyId`
// derived at query time (`gen_ai.conversation.id` → `session.id` → `TraceId`).
//
// Three things this layer owns, because every client would otherwise redo them:
//
//   - the **title ladder** (first user message → agent → model → id),
//   - **cost presence** (no cost attribute ⇒ `null`, never `0`),
//   - the **cumulative-input dedupe** and tool-call nesting (`buildJourneyTimeline`).
// ---------------------------------------------------------------------------

const warehouseDateTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max)}…`)

/**
 * The first *user* message of the journey, from the earliest span's (cumulative)
 * `gen_ai.input.messages`.
 *
 * Returns `null` — not `""` — when there is none, which is the common case:
 * privacy modes strip exactly this. The row then falls back to agent → model →
 * journey id client-side, so no row ever renders as blank.
 */
const deriveTitle = (titleSource: string): string | null => {
	const messages = CH.parseGenAiMessages(titleSource, "user")
	const firstUser = messages.find((m) => m.role === "user" && m.text !== "")
	const fallback = messages.find((m) => m.text !== "")
	const text = (firstUser ?? fallback)?.text
	return text === undefined || text === "" ? null : truncate(text.trim(), 160)
}

/**
 * Numbers arrive already decoded — `journeyListRowSchema` runs every aggregate
 * through `CH.CHNumber`, which accepts both the quoted and unquoted 64-bit wire
 * shapes. Re-coercing with `Number(...)` here would only hide a future drift as
 * `NaN` instead of failing the decode with a tagged error.
 */
const toListItem = (row: CH.JourneyListOutput) => ({
	journeyId: row.journeyId,
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
	// Presence, not magnitude, decides null: a journey whose emitter never sent
	// a cost is unknown-cost, and the header omits the stat instead of $0.00.
	cost: row.costSpanCount > 0 ? row.cost : null,
	models: row.models,
	requestedModels: row.requestedModels,
	providers: row.providers,
	agents: row.agents,
	workflowName: row.workflowName,
	finishReasons: row.finishReasons,
	serviceName: row.serviceName,
	// Error wins over running: a journey that already failed is not "in progress"
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

export const HttpGenAiJourneysLive = HttpApiBuilder.group(MapleApi, "genaiJourneys", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		return handlers
			.handle("listJourneys", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compile(
						CH.journeyListQuery({
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
						{ rowSchema: CH.journeyListRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "listJourneys",
					})
					return new ListJourneysResponse({ data: rows.map(toListItem) })
				}),
			)
			.handle("facets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compileUnion(
						CH.journeyFacetsQuery({
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
						{ rowSchema: CH.journeyFacetsRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "journeyFacets",
					})
					// Counts arrive decoded: the query declares `journeyFacetsRowSchema`,
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
					return new JourneyFacetsResponse({
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
			.handle("journeySummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.journey.id": payload.journeyId,
					})
					const now = yield* Clock.currentTimeMillis
					const startTime = payload.startTime ?? warehouseDateTime(now - JOURNEY_DETAIL_WINDOW_MS)
					const endTime = payload.endTime ?? warehouseDateTime(now)
					const compiled = CH.compile(
						CH.journeySummaryQuery(),
						{ orgId: tenant.orgId, startTime, endTime, journeyId: payload.journeyId },
						{ rowSchema: CH.journeySummaryRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "aggregation",
						context: "journeySummary",
					})
					const row = rows[0]
					return new JourneySummaryResponse({ data: row ? toListItem(row) : null })
				}),
			)
			.handle("journeyTimeline", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.journey.id": payload.journeyId,
					})
					const now = yield* Clock.currentTimeMillis
					const startTime = payload.startTime ?? warehouseDateTime(now - JOURNEY_DETAIL_WINDOW_MS)
					const endTime = payload.endTime ?? warehouseDateTime(now)
					const limit = Math.min(
						payload.limit ?? JOURNEY_TIMELINE_SPAN_CAP,
						JOURNEY_TIMELINE_SPAN_CAP,
					)
					const compiled = CH.compile(
						CH.journeyTimelineQuery({ limit, offset: payload.offset }),
						{ orgId: tenant.orgId, startTime, endTime, journeyId: payload.journeyId },
						{ rowSchema: CH.journeyTimelineRowSchema },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "journeyTimeline",
					})
					// Cumulative-input dedupe + tool-call nesting happen here, once,
					// rather than in every client that reads a journey. It is a
					// multi-megabyte JSON.parse over every message-bearing span, so it
					// gets its own span — otherwise a slow journey detail looks like a
					// slow warehouse query and the CPU time is invisible.
					const events = yield* Effect.sync(() => CH.buildJourneyTimeline(rows)).pipe(
						Effect.withSpan("buildJourneyTimeline", {
							attributes: {
								"maple.journey.id": payload.journeyId,
								"maple.journey.span_count": rows.length,
							},
						}),
					)
					yield* Effect.annotateCurrentSpan({
						"maple.journey.span_count": rows.length,
						"maple.journey.event_count": events.length,
						"maple.journey.truncated": rows.length >= limit,
					})
					return new JourneyTimelineResponse({
						events,
						spanCount: rows.length,
						truncated: rows.length >= limit,
					})
				}),
			)
	}),
)
