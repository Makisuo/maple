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
 * Identical SQL was not enough on its own: the browser's server function for
 * each endpoint also *shapes* the rows before the tile sees them (for
 * `service_overview`, `spanCount` becomes a per-second, sampling-corrected
 * `throughput`), and a plan that returned raw rows gave a shared "Traffic" stat
 * 24.4M where the board showed 5.6K. Every plan now ends in the same shaper
 * (`@maple/query-engine` `route-rows.ts`) the browser calls, so what the tile
 * receives is the same object on both hosts.
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
import {
	coerceErrorsByTypeRows,
	coerceErrorsSummary,
	coerceLogRows,
	coerceServiceOverviewRows,
	coerceServiceUsageRows,
	serviceUsagePreviousTotals,
	windowDurationSeconds,
} from "@maple/query-engine"
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
 * What a plan hands the tile: the browser's server function's return value for
 * the same endpoint, `{ data, …extras }`. The client unwraps `data` through the
 * one `toReadyWidgetData` in `use-widget-data.ts` for both paths. (Renderers do
 * NOT unwrap it themselves — that assumption once left every chart on a shared
 * board holding an object where an array belongs.)
 */
export interface RouteEndpointResponse {
	readonly data: unknown
	readonly [extra: string]: unknown
}

type RouteEndpointRowMapper<Payload, Row> = (
	rows: ReadonlyArray<Row>,
	payload: Payload,
	context: RouteEndpointContext,
) => RouteEndpointResponse

/**
 * Build a plan from a request schema, a registry query definition and the row
 * mapper the browser applies to that definition's rows.
 */
const readModelPlan = <Payload, Row>(
	payloadSchema: Schema.Codec<Payload, unknown, never, never>,
	definition: QueryDefinition<Payload, Row>,
	toResponse: RouteEndpointRowMapper<Payload, Row>,
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
				return toResponse(rows, payload, context)
			}),
	}
}

const asRows = <Row>(rows: ReadonlyArray<Row>): ReadonlyArray<Record<string, unknown>> =>
	// SAFETY: registry rows are decoded records; the shapers read them field by
	// field with `?? 0` / `String(...)` defaults exactly as the browser does.
	rows as ReadonlyArray<Record<string, unknown>>

export const ROUTE_ENDPOINT_PLANS: RouteEndpointPlanRegistry = {
	errors_by_type: readModelPlan(ErrorsByTypeRequest, Queries.errorsByType, (rows) => ({
		data: coerceErrorsByTypeRows(asRows(rows)),
	})),
	// One row, rendered as a scalar object — the browser's `getErrorsSummary`
	// returns `data: summary | null`, never a one-row list.
	errors_summary: readModelPlan(ErrorsSummaryRequest, Queries.errorsSummary, (rows) => ({
		data: coerceErrorsSummary(asRows(rows)[0]),
	})),
	service_overview: readModelPlan(
		ServiceOverviewRequest,
		Queries.serviceOverview,
		(rows, _payload, context) => ({
			data: coerceServiceOverviewRows(
				asRows(rows),
				windowDurationSeconds(context.window.startTime, context.window.endTime),
			),
		}),
	),
	service_usage: readModelPlan(ServiceUsageRequest, Queries.serviceUsage, (rows, payload) => {
		const usageRows = asRows(rows)
		if (usageRows.length === 0) return { data: [] }
		const wantsPrevious = payload.previousStartTime != null && payload.previousEndTime != null
		return {
			previousTotals: wantsPrevious ? serviceUsagePreviousTotals(usageRows) : undefined,
			data: coerceServiceUsageRows(usageRows),
		}
	}),
	list_logs: readModelPlan(ListLogsRequest, Queries.listLogs, (rows, payload) => {
		const logs = coerceLogRows(asRows(rows))
		const limit = payload.limit
		const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null
		return { data: logs, meta: { limit, cursor } }
	}),
}

/** Endpoints a shared dashboard can render. Used by the dialog's warning list. */
export const SUPPORTED_ROUTE_ENDPOINTS: ReadonlySet<string> = new Set(Object.keys(ROUTE_ENDPOINT_PLANS))
