/**
 * Server-side implementations of the `route`-kind widget data sources.
 *
 * A `route` data source stores `{ endpoint, params }` — a name and an opaque
 * bag. In the browser that name indexes `serverFunctionMap`, and the function
 * behind it builds a `QuerySpec` and posts it. A shared dashboard's viewer
 * cannot be trusted to do that, so the same names have to resolve to something
 * the *server* can run.
 *
 * Rather than reimplementing those queries, each plan decodes the stored params
 * against the endpoint's existing request schema and runs the existing query
 * definition from `@maple/query-engine/registry` — the same definition, profile
 * and cache policy the authenticated route uses. A shared board and a signed-in
 * board therefore execute byte-identical SQL.
 *
 * The registry is intentionally a closed allowlist. An endpoint absent from it
 * is not "unimplemented, fall through to something generic" — it is a widget the
 * share surface refuses to render, reported as `ShareUnsupportedWidgetError` and
 * drawn as a muted tile. Adding an entry here is the deliberate act of deciding
 * a widget is safe to serve without a session.
 */
import {
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ListLogsRequest,
	ServiceOverviewRequest,
	ServiceUsageRequest,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Queries, type QueryDefinition } from "@maple/query-engine/registry"
import { makeQueryRunners } from "@/routes/query-runner"
import type { QueryEngineServiceApi } from "@/services/warehouse/QueryEngineService"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@/services/auth/tenant-context"

export interface RouteEndpointContext {
	readonly tenant: TenantContext
	readonly queryEngine: QueryEngineServiceApi
	readonly warehouse: WarehouseQueryServiceApi
	readonly window: { readonly startTime: string; readonly endTime: string }
}

export interface RouteEndpointPlan {
	readonly run: (
		params: Record<string, unknown>,
		context: RouteEndpointContext,
	) => Effect.Effect<unknown, unknown>
}

interface RouteEndpointPlanRegistry {
	readonly [endpoint: string]: RouteEndpointPlan
}

/**
 * Build a plan from a request schema plus a registry query definition.
 *
 * `rows` is handed back under a `data` key because that is the envelope every
 * widget renderer already unwraps — the browser's server functions return
 * `{ data }` too, so the share transport carries the same shape and the client
 * needs no share-specific unwrapping.
 */
const readModelPlan = <Payload, Row>(
	payloadSchema: Schema.Codec<Payload, unknown, never, never>,
	definition: QueryDefinition<Payload, Row>,
): RouteEndpointPlan => {
	const decode = Schema.decodeUnknownEffect(payloadSchema)
	return {
		run: (params, context) =>
			Effect.gen(function* () {
				// Decoding is the boundary check, not a formality: a stored params bag
				// is only as trustworthy as the author who wrote it, and after variable
				// interpolation it contains viewer-influenced strings.
				const payload = yield* decode({
					...params,
					startTime: context.window.startTime,
					endTime: context.window.endTime,
				})
				const { runQuery } = makeQueryRunners({
					warehouse: context.warehouse,
					queryEngine: context.queryEngine,
				})
				const rows = yield* runQuery(definition, context.tenant, payload)
				return { data: rows }
			}),
	}
}

export const ROUTE_ENDPOINT_PLANS: RouteEndpointPlanRegistry = {
	errors_by_type: readModelPlan(ErrorsByTypeRequest, Queries.errorsByType),
	errors_summary: readModelPlan(ErrorsSummaryRequest, Queries.errorsSummary),
	service_overview: readModelPlan(ServiceOverviewRequest, Queries.serviceOverview),
	service_usage: readModelPlan(ServiceUsageRequest, Queries.serviceUsage),
	list_logs: readModelPlan(ListLogsRequest, Queries.listLogs),
}

/** Endpoints a shared dashboard can render. Used by the dialog's warning list. */
export const SUPPORTED_ROUTE_ENDPOINTS: ReadonlySet<string> = new Set(Object.keys(ROUTE_ENDPOINT_PLANS))
