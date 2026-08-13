import type { Effect } from "effect"
import type { WarehouseError } from "@maple/domain"

/**
 * The one place the warehouse error union is enumerated for `Effect.catchTags`.
 * Each consumer supplies its own conversion; adding a tag to `WarehouseError`
 * means updating this table (and the meta Record in `@maple/domain`) instead of
 * one hand-written 9-arm table per surface. The handler receives the union
 * (every member is assignable), so the residual error channel still infers
 * correctly at the call site.
 */
export const warehouseHandlers = <A, E, R>(f: (error: WarehouseError) => Effect.Effect<A, E, R>) =>
	({
		"@maple/http/errors/WarehouseQueryError": f,
		"@maple/http/errors/WarehouseUpstreamError": f,
		"@maple/http/errors/WarehouseAuthError": f,
		"@maple/http/errors/WarehouseConfigError": f,
		"@maple/http/errors/WarehouseConfigLookupError": f,
		"@maple/http/errors/WarehouseClientError": f,
		"@maple/http/errors/WarehouseSchemaDriftError": f,
		"@maple/http/errors/WarehouseMalformedQueryError": f,
		"@maple/http/errors/WarehouseQuotaExceededError": f,
		"@maple/http/errors/WarehouseValidationError": f,
	}) as const
