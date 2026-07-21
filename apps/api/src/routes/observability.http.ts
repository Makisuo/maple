import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi, SpanId, TraceId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import {
	listServices,
	searchTraces,
	inspectTrace,
	findErrors,
	diagnoseService,
	searchLogs,
} from "@maple/query-engine/observability"
import { makeWarehouseExecutorFromTenant } from "../lib/WarehouseQueryService"

// Warehouse errors propagate with their canonical per-tag HTTP statuses (503
// transient, 429 quota, 400 validation, 502 otherwise) — declared on the
// observability endpoints via `warehouseHttpErrors`. No 500-flatten here.

const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)

const brandLogIds = <T extends { readonly traceId?: string; readonly spanId?: string }>(log: T) => ({
	...log,
	traceId: log.traceId ? decodeTraceId(log.traceId) : undefined,
	spanId: log.spanId ? decodeSpanId(log.spanId) : undefined,
})

export const HttpObservabilityLive = HttpApiBuilder.group(MapleApi, "observability", (handlers) =>
	Effect.gen(function* () {
		return handlers
			.handle("listServices", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const services = yield* listServices(payload).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
					)
					return { services: [...services] }
				}),
			)
			.handle("searchTraces", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* searchTraces(payload).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
						Effect.map((r) => ({
							...r,
							spans: [...r.spans].map((s) => ({ ...s, attributes: { ...s.attributes } })),
						})),
					)
				}),
			)
			.handle("inspectTrace", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* inspectTrace(payload.traceId).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
					)
					return {
						traceId: result.traceId,
						serviceCount: result.serviceCount,
						spanCount: result.spanCount,
						rootDurationMs: result.rootDurationMs,
						spans: result.spans,
						logs: result.logs.map(brandLogIds),
					}
				}),
			)
			.handle("findErrors", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const errors = yield* findErrors(payload).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
					)
					return { errors: [...errors] }
				}),
			)
			.handle("diagnoseService", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* diagnoseService(payload).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
					)
					return {
						serviceName: result.serviceName,
						timeRange: result.timeRange,
						health: result.health,
						topErrors: result.topErrors,
						recentTraces: result.recentTraces.map((trace) => ({
							...trace,
							traceId: decodeTraceId(trace.traceId),
						})),
						recentLogs: result.recentLogs.map(brandLogIds),
					}
				}),
			)
			.handle("searchLogs", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* searchLogs(payload).pipe(
						Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
					)
					return {
						timeRange: result.timeRange,
						total: result.total,
						logs: result.logs.map(brandLogIds),
						pagination: result.pagination,
					}
				}),
			)
	}),
)
