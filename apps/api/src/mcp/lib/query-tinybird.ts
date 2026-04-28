import { HttpServerRequest } from "effect/unstable/http"
import type { TinybirdPipe } from "@maple/domain"
import { Effect } from "effect"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { McpAuthMissingError, McpQueryError } from "@/mcp/tools/types"
import { TinybirdService } from "@/services/TinybirdService"
import { TinybirdExecutor } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"
import type { TenantContext } from "@/services/AuthService"

export const resolveTenant = Effect.gen(function* () {
	const req = yield* HttpServerRequest.HttpServerRequest
	const nativeReq = yield* HttpServerRequest.toWeb(req).pipe(
		Effect.mapError((e) => new McpAuthMissingError({ message: `Failed to read request: ${e.message}` })),
	)
	return yield* resolveMcpTenantContext(nativeReq)
})

/** Infrastructure binding: resolves tenant and provides TinybirdExecutor layer. */
export const withTenantExecutor = <A, E>(effect: Effect.Effect<A, E, TinybirdExecutor>) =>
	Effect.gen(function* () {
		const tenant = yield* resolveTenant
		return yield* Effect.provide(effect, makeTinybirdExecutorFromTenant(tenant))
	})

export const queryTinybird = <T = any>(pipe: TinybirdPipe, params?: Record<string, unknown>) =>
	Effect.gen(function* () {
		const tenant = yield* resolveTenant
		const service = yield* TinybirdService
		const response = yield* service.query(tenant, { pipe, params }).pipe(
			Effect.mapError(
				(error) =>
					new McpQueryError({
						message: error.message,
						pipe,
					}),
			),
		)

		return { data: response.data as T[] }
	})
