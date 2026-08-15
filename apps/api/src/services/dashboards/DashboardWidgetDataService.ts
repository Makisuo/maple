/**
 * Server-side widget data.
 *
 * Turns "this widget, over this window, with these variable values" into rows,
 * building the query **from the stored dashboard document** rather than from
 * anything the caller supplied.
 *
 * That inversion is the whole point. In the browser, a widget's query is
 * compiled client-side and posted as a `QuerySpec` — fine when the caller is
 * already an authenticated member of the org, since they could issue the query
 * directly anyway. A share link is different: it is a credential anyone may
 * hold, so accepting a query from its holder would turn the link into a full
 * read credential for the org's warehouse. Here the caller names a widget; the
 * server decides what that widget means.
 *
 * What a caller may still choose — because a viewer is allowed to change them —
 * is the time window and the dashboard variable values. Both are bounded before
 * anything executes: `resolveShareWindow` for the window, and the variable
 * checks in `share-variables.ts` for the values.
 */
import {
	type DashboardDocument,
	type DashboardVariable,
	OrgId,
	ShareUnsupportedWidgetError,
	ShareWidgetNotFoundError,
	UserId,
} from "@maple/domain/http"
import { RoleName } from "@maple/domain/primitives"
import {
	interpolateTimeMacros,
	interpolateWidgetParams,
	LIST_ENDPOINTS,
	MAX_LIST_RANGE_SECONDS,
	type VariableValues,
} from "@maple/query-engine"
import { runQuerySet } from "@maple/query-engine/query-set"
import {
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	dataSourceEndpoint,
} from "@maple/widgets/dashboard"
import { Context, Effect, Layer, Schema } from "effect"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@/services/auth/tenant-context"
import { makeServerQuerySetExecutor } from "./server-query-set-executor"
import { ROUTE_ENDPOINT_PLANS, type RouteEndpointContext } from "./route-endpoint-plans"
import { autoBucketSeconds, runRawSql } from "@/mcp/lib/run-raw-sql"

const UNSUPPORTED_WIDGET_MESSAGE = "This widget isn't available in shared views."

const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

/**
 * The identity a shared dashboard's queries execute under.
 *
 * A system tenant, not a bypass: `validateTenantScope` still refuses any
 * compiled query that lacks a top-level `OrgId` predicate, so this widens
 * nothing — it only supplies the org whose data the share points at, for a
 * viewer who has no account of their own.
 */
export const shareViewerTenant = (orgId: OrgId): TenantContext => ({
	orgId,
	userId: decodeUserIdSync("system-share-viewer"),
	roles: [decodeRoleNameSync("root")],
	authMode: "self_hosted",
})

export interface ResolvedWindow {
	readonly startTime: string
	readonly endTime: string
}

export interface WidgetDataRequest {
	readonly widgetId: string
	/** Which data source on the widget — the tile itself, or its sparkline. */
	readonly source: "primary" | "sparkline"
}

export interface WidgetDataOutcome {
	readonly widgetId: string
	readonly source: WidgetDataRequest["source"]
	readonly data: unknown
	/**
	 * Set when the requested window was wider than the widget's shape allows and
	 * the server narrowed it. The tile says "showing the last N days" rather than
	 * silently displaying a different window than the picker shows.
	 */
	readonly narrowedToSeconds?: number
}

/** Every widget on a document, including those nested in sections and tabs. */
const findWidget = (document: DashboardDocument, widgetId: string) =>
	document.widgets.find((widget) => widget.id === widgetId)

const rangeSecondsOf = (window: ResolvedWindow): number =>
	Math.max(0, (Date.parse(`${window.endTime}Z`) - Date.parse(`${window.startTime}Z`)) / 1000)

export interface DashboardWidgetDataServiceApi {
	readonly resolve: (
		orgId: OrgId,
		document: DashboardDocument,
		request: WidgetDataRequest,
		window: ResolvedWindow,
		variableValues: VariableValues,
	) => Effect.Effect<WidgetDataOutcome, ShareWidgetNotFoundError | ShareUnsupportedWidgetError>
}

export class DashboardWidgetDataService extends Context.Service<
	DashboardWidgetDataService,
	DashboardWidgetDataServiceApi
>()("@maple/api/services/DashboardWidgetDataService", {
	make: Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const warehouse = yield* WarehouseQueryService

		const resolve = Effect.fn("DashboardWidgetDataService.resolve")(function* (
			orgId: OrgId,
			document: DashboardDocument,
			request: WidgetDataRequest,
			window: ResolvedWindow,
			variableValues: VariableValues,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.dashboard.id": document.id,
				"maple.widget.id": request.widgetId,
				"maple.widget.source": request.source,
			})

			const widget = findWidget(document, request.widgetId)
			if (widget === undefined) {
				return yield* Effect.fail(
					new ShareWidgetNotFoundError({
						message: "That widget is not on this dashboard.",
						widgetId: request.widgetId,
					}),
				)
			}

			const dataSource =
				request.source === "sparkline" ? widget.display?.sparkline?.dataSource : widget.dataSource
			if (dataSource === undefined) {
				return yield* Effect.fail(
					new ShareWidgetNotFoundError({
						message: "That widget is not on this dashboard.",
						widgetId: request.widgetId,
					}),
				)
			}

			const tenant = shareViewerTenant(orgId)
			const executor = makeServerQuerySetExecutor(tenant, queryEngine)

			// A markdown/static tile has nothing to fetch. It is a success with no
			// data, not an unsupported widget — the renderer draws it from the
			// document alone.
			const querySet = dataSourceQuerySet(dataSource)
			const rawSql = dataSourceRawSql(dataSource)
			const endpoint = dataSourceEndpoint(dataSource)

			if (querySet === null && rawSql === null && endpoint === null) {
				return {
					widgetId: request.widgetId,
					source: request.source,
					data: null,
				} satisfies WidgetDataOutcome
			}

			// Clamp before executing. A list-shaped tile scans raw rows, so a viewer
			// dragging the picker to 30 days would otherwise issue a scan the signed-in
			// UI refuses. The authed app offers an opt-in "narrow" button; a chrome-less
			// viewer has nowhere to put one, so the server narrows and says so.
			const isListShaped =
				querySet?.resultShape === "list" || (endpoint !== null && LIST_ENDPOINTS.has(endpoint))
			const requestedSeconds = rangeSecondsOf(window)
			const narrowed = isListShaped && requestedSeconds > MAX_LIST_RANGE_SECONDS
			const effectiveWindow: ResolvedWindow = narrowed
				? {
						startTime: new Date(Date.parse(`${window.endTime}Z`) - MAX_LIST_RANGE_SECONDS * 1000)
							.toISOString()
							.replace("T", " ")
							.slice(0, 19),
						endTime: window.endTime,
					}
				: window
			const narrowedFields = narrowed ? { narrowedToSeconds: MAX_LIST_RANGE_SECONDS } : undefined

			if (querySet !== null) {
				const result = yield* runQuerySet(executor, {
					querySet: {
						queries: querySet.queries,
						...(querySet.formulas === undefined ? {} : { formulas: querySet.formulas }),
						...(querySet.comparison === undefined ? {} : { comparison: querySet.comparison }),
					},
					resultShape: querySet.resultShape,
					startTime: effectiveWindow.startTime,
					endTime: effectiveWindow.endTime,
					...(querySet.defaultLimit === undefined ? {} : { defaultLimit: querySet.defaultLimit }),
					...(querySet.limit === undefined ? {} : { limit: querySet.limit }),
					...(querySet.columns === undefined ? {} : { columns: querySet.columns }),
				}).pipe(
					// A query set that cannot run is reported as an unsupported widget
					// rather than failing the whole batch: one broken tile on a shared
					// board must not blank its neighbours.
					Effect.catch(() =>
						Effect.fail(
							new ShareUnsupportedWidgetError({
								message: UNSUPPORTED_WIDGET_MESSAGE,
								widgetId: request.widgetId,
								kind: "query",
							}),
						),
					),
				)

				return {
					widgetId: request.widgetId,
					source: request.source,
					data: { data: result.rows },
					...narrowedFields,
				} satisfies WidgetDataOutcome
			}

			if (rawSql !== null) {
				// The SQL is the dashboard author's, never the viewer's — it comes off
				// the stored document and no share payload can influence it. It still
				// goes through `runRawSql`, the same macro-expanding, org-filter-
				// enforcing path the MCP tools use, so a board shared by an author who
				// wrote a careless query is still confined to their own org.
				const result = yield* runRawSql({
					tenant,
					sql: rawSql.sql,
					startTime: effectiveWindow.startTime,
					endTime: effectiveWindow.endTime,
					granularitySeconds:
						rawSql.granularitySeconds ??
						autoBucketSeconds(effectiveWindow.startTime, effectiveWindow.endTime),
				}).pipe(
					// The service instance is already in scope, so the raw-SQL helper's
					// requirement is discharged here rather than leaking into every
					// caller of `resolve`.
					Effect.provideService(WarehouseQueryService, warehouse),
					Effect.catch(() =>
						Effect.fail(
							new ShareUnsupportedWidgetError({
								message: UNSUPPORTED_WIDGET_MESSAGE,
								widgetId: request.widgetId,
								kind: "raw_sql",
							}),
						),
					),
				)

				return {
					widgetId: request.widgetId,
					source: request.source,
					data: { data: result.rows },
					...narrowedFields,
				} satisfies WidgetDataOutcome
			}

			const plan = endpoint === null ? undefined : ROUTE_ENDPOINT_PLANS[endpoint]
			if (plan === undefined) {
				return yield* Effect.fail(
					new ShareUnsupportedWidgetError({
						message: UNSUPPORTED_WIDGET_MESSAGE,
						widgetId: request.widgetId,
						kind: endpoint ?? "unknown",
					}),
				)
			}

			// Route params get the same two interpolation passes, in the same order,
			// as the browser: time macros first, then dashboard variables.
			const routeParams = interpolateWidgetParams(
				interpolateTimeMacros(
					{
						...(dataSourceRouteParams(dataSource) ?? {}),
						startTime: effectiveWindow.startTime,
						endTime: effectiveWindow.endTime,
					},
					effectiveWindow,
				),
				variableValues,
			)

			const context: RouteEndpointContext = {
				tenant,
				queryEngine,
				warehouse,
				window: effectiveWindow,
			}

			const data = yield* plan.run(routeParams, context).pipe(
				Effect.catch(() =>
					Effect.fail(
						new ShareUnsupportedWidgetError({
							message: UNSUPPORTED_WIDGET_MESSAGE,
							widgetId: request.widgetId,
							kind: endpoint ?? "unknown",
						}),
					),
				),
			)

			return {
				widgetId: request.widgetId,
				source: request.source,
				data,
				...narrowedFields,
			} satisfies WidgetDataOutcome
		})

		return { resolve } satisfies DashboardWidgetDataServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

export type { DashboardVariable }
