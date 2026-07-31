import { HttpServerRequest } from "effect/unstable/http"
import type { WarehouseQueryName } from "@maple/domain"
import { Context, Effect, Schema } from "effect"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import type { TenantContext } from "@/lib/tenant-context"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { McpAuthMissingError, McpQueryError } from "@/mcp/tools/types"
import { WarehouseQueryService } from "@/lib/WarehouseQueryService"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { makeWarehouseExecutorFromTenant } from "@/lib/WarehouseQueryService"

export class CurrentMcpTenant extends Context.Service<CurrentMcpTenant, TenantContext>()(
	"@maple/api/mcp/CurrentMcpTenant",
) {}

export const resolveHttpMcpTenant = Effect.gen(function* () {
	const req = yield* HttpServerRequest.HttpServerRequest
	const nativeReq = yield* HttpServerRequest.toWeb(req).pipe(
		Effect.mapError((e) => new McpAuthMissingError({ message: `Failed to read request: ${e.message}` })),
	)
	return yield* resolveMcpTenantContext(nativeReq)
})

export const resolveTenant = CurrentMcpTenant

/** Infrastructure binding: resolves tenant and provides WarehouseExecutor layer. */
export const withTenantExecutor = <A, E>(effect: Effect.Effect<A, E, WarehouseExecutor>) =>
	Effect.gen(function* () {
		const tenant = yield* resolveTenant
		return yield* Effect.provide(effect, makeWarehouseExecutorFromTenant(tenant))
	}).pipe(Effect.withSpan("withTenantExecutor"))

/**
 * Pass `rowSchema` to validate the warehouse rows; without it the rows are
 * returned as an unchecked `T[]` cast.
 */
export const queryWarehouse = Effect.fn("queryWarehouse")(function* <T = any>(
	pipe: WarehouseQueryName,
	params?: Record<string, unknown>,
	rowSchema?: Schema.ConstraintDecoder<T>,
) {
	const tenant = yield* resolveTenant
	const service = yield* WarehouseQueryService
	const response = yield* service
		.query(tenant, { pipeName: pipe, params })
		.pipe(Effect.mapError(toMcpQueryError(pipe)))

	if (rowSchema === undefined) return { data: response.data as T[] }

	const rows = yield* Schema.decodeUnknownEffect(Schema.Array(rowSchema))(response.data).pipe(
		Effect.mapError(
			(error) =>
				new McpQueryError({
					message: `Unexpected ${pipe} response shape: ${String(error)}`,
					pipeName: pipe,
					cause: error,
				}),
		),
	)

	return { data: rows as T[] }
})
