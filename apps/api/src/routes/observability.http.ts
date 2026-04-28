import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { ObservabilityApiError } from "@maple/domain/http/observability"
import { Effect } from "effect"
import {
	listServices,
	searchTraces,
	inspectTrace,
	findErrors,
	diagnoseService,
	searchLogs,
} from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "../services/TinybirdExecutorLive"

const mapError = (e: { message: string; pipe?: string }) =>
	new ObservabilityApiError({ message: e.message, pipe: e.pipe, cause: e })

export const HttpObservabilityLive = HttpApiBuilder.group(MapleApi, "observability", (handlers) =>
	Effect.gen(function* () {
		return handlers
			.handle("listServices", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const services = yield* listServices(payload).pipe(
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
					)
					return { services: [...services] }
				}),
			)
			.handle("searchTraces", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* searchTraces(payload).pipe(
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
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
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
					)
					return {
						traceId: result.traceId,
						serviceCount: result.serviceCount,
						spanCount: result.spanCount,
						rootDurationMs: result.rootDurationMs,
						spans: result.spans as any,
						logs: result.logs as any,
					}
				}),
			)
			.handle("findErrors", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const errors = yield* findErrors(payload).pipe(
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
					)
					return { errors: [...errors] }
				}),
			)
			.handle("diagnoseService", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* diagnoseService(payload).pipe(
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
					)
					return {
						serviceName: result.serviceName,
						timeRange: result.timeRange,
						health: result.health as any,
						topErrors: result.topErrors as any,
						recentTraces: result.recentTraces as any,
						recentLogs: result.recentLogs as any,
					}
				}),
			)
			.handle("searchLogs", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* searchLogs(payload).pipe(
						Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
						Effect.mapError(mapError),
					)
					return {
						timeRange: result.timeRange,
						total: result.total,
						logs: result.logs as any,
						pagination: result.pagination,
					}
				}),
			)
	}),
)
