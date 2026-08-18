import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AgentSessionDetailResponse,
	AgentSessionsFacetsResponse,
	AgentSessionsListResponse,
	AgentTracesListResponse,
	CurrentTenant,
	MapleInternalApi,
	TraceId,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import {
	agentSessionsFacets,
	getAgentSessionDetail,
	listAgentSessions,
	listAgentTraces,
	type AgentSessionsFilterInput,
} from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

const decodeTraceId = Schema.decodeSync(TraceId)

/**
 * Agent Sessions dashboard routes — thin adapters over the
 * `@maple/query-engine/observability` read functions, which are the durable
 * interface (the future MCP tools call those functions, not these routes).
 * Internal tier: the response shapes follow the UI.
 */
export const HttpAgentSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"agentSessionsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const filterInput = (payload: {
				startTime: string
				endTime: string
				vendors?: readonly string[] | undefined
				serviceNames?: readonly string[] | undefined
				hasErrors?: boolean | undefined
			}): AgentSessionsFilterInput => ({
				startTime: payload.startTime,
				endTime: payload.endTime,
				vendors: payload.vendors,
				serviceNames: payload.serviceNames,
				hasErrors: payload.hasErrors,
			})

			return handlers
				.handle("list", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const rows = yield* listAgentSessions({
							...filterInput(payload),
							limit: payload.limit,
							offset: payload.offset,
						}).pipe(provideWarehouseExecutorFromTenant(tenant))
						// Integer aggregates can arrive as JSON strings (quoted 64-bit wire on
						// gateway/readonly clusters); these queries declare no rowSchema, so
						// coerce before the Schema.Number response fields validate.
						return new AgentSessionsListResponse({
							data: rows.map((row) => ({
								sessionKeyHash: row.sessionKeyHash,
								startTime: row.startTime,
								endTime: row.endTime,
								durationMs: Number(row.durationMs),
								traceCount: Number(row.traceCount),
								keyedSpanCount: Number(row.keyedSpanCount),
								errorCount: Number(row.errorCount),
								vendors: row.vendors,
								serviceNames: row.serviceNames,
							})),
						})
					}),
				)
				.handle("traces", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const rows = yield* listAgentTraces({
							...filterInput(payload),
							limit: payload.limit,
							offset: payload.offset,
						}).pipe(provideWarehouseExecutorFromTenant(tenant))
						return new AgentTracesListResponse({
							data: rows.map((row) => ({
								traceId: decodeTraceId(row.traceId),
								startTime: row.startTime,
								endTime: row.endTime,
								durationMs: Number(row.durationMs),
								aiSpanCount: Number(row.aiSpanCount),
								errorCount: Number(row.errorCount),
								vendors: row.vendors,
								serviceNames: row.serviceNames,
								firstSpanName: row.firstSpanName,
								bestSessionKeyState: Number(row.bestSessionKeyState),
								sessionKeyHash: row.sessionKeyHash,
							})),
						})
					}),
				)
				.handle("detail", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const detail = yield* getAgentSessionDetail({
							sessionKeyHash: payload.sessionKeyHash,
							startTime: payload.startTime,
							endTime: payload.endTime,
						}).pipe(provideWarehouseExecutorFromTenant(tenant))
						// The read function already normalizes every numeric through the
						// integration layer (real JS numbers, not wire strings); only the
						// TraceId brand needs decoding at this boundary.
						return new AgentSessionDetailResponse({
							session:
								detail === null
									? null
									: {
											...detail,
											traces: detail.traces.map((trace) => ({
												traceId: decodeTraceId(trace.traceId),
												startTime: trace.startTime,
												durationMs: trace.durationMs,
												errorCount: trace.errorCount,
												spans: trace.spans.map(
													({ traceId: _traceId, ...span }) => span,
												),
											})),
										},
						})
					}),
				)
				.handle("facets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const rows = yield* agentSessionsFacets({
							...filterInput(payload),
							tab: payload.tab,
						}).pipe(provideWarehouseExecutorFromTenant(tenant))
						const pick = (facetType: string) =>
							rows
								.filter((row) => row.facetType === facetType)
								.map((row) => ({ name: row.name, count: Number(row.count) }))
						return new AgentSessionsFacetsResponse({
							vendors: pick("vendor"),
							services: pick("service"),
							// The error branch emits a single row, and none at all when the
							// filtered population has no errors.
							errorCount: Number(rows.find((row) => row.facetType === "error")?.count ?? 0),
						})
					}),
				)
		}),
)
