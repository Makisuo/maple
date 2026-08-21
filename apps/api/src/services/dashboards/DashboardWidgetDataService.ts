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
 *
 * From there the request is built by the same two functions the signed-in
 * browser runs — `toWidgetRequest` to lower the stored source, then
 * `planWidgetRequest` for the window (a pinned tile beats the board), the time
 * macros, the variables and the fetch strategy — and executed by the same
 * runners. This service adds nothing of its own to the query; it only decides
 * *which* widget the caller may ask about and confines a list scan to the cap.
 * That is what makes a shared board show the numbers the board shows.
 */
import {
	type DashboardDocument,
	type DashboardVariable,
	OrgId,
	ShareUnsupportedWidgetError,
	ShareWidgetExecutionError,
	ShareWidgetNotFoundError,
	UserId,
} from "@maple/domain/http"
import { RoleName } from "@maple/domain/primitives"
import { QuerySetSchema } from "@maple/query-model"
import {
	MAX_LIST_RANGE_SECONDS,
	computeBucketSecondsForRange,
	dashboardVariableOptionsFromResult,
	dashboardVariableOptionsQuery,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	planWidgetRequest,
	rawSqlRowsForDisplay,
	type PlannedWidgetRequest,
	type VariableValues,
} from "@maple/query-engine"
import { fallbackStrategyFromWire, runQuerySet } from "@maple/query-engine/query-set"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import type { WarehouseExecutionError } from "@maple/query-engine/execution"
import type { RawSqlValidationError } from "@maple/domain/http"
import {
	dataSourceQuerySet,
	MARKDOWN_STATIC_ENDPOINT,
	QUERY_RESULT_ENDPOINTS,
	RAW_SQL_ENDPOINT,
	toWidgetRequest,
} from "@maple/widgets/dashboard"
import { Context, Effect, Layer, Schema } from "effect"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@/services/auth/tenant-context"
import { makeServerQuerySetExecutor } from "./server-query-set-executor"
import { ROUTE_ENDPOINT_PLANS, type RouteEndpointContext } from "./route-endpoint-plans"
import { resolveShareWindow } from "./share-window"

const UNSUPPORTED_WIDGET_MESSAGE = "This widget isn't available in shared views."
const EXECUTION_FAILED_MESSAGE = "This widget couldn't be loaded. Try again shortly."

/**
 * A widget's query ran and failed.
 *
 * Logs the cause before mapping. Without this the share surface was the one
 * place in the API where a warehouse failure vanished entirely — the tile said
 * "not available in shared views" and nothing on the server recorded why, so a
 * broken shared board looked identical to a deliberately unsupported one.
 */
const executionFailed = (widgetId: string, kind: string) => (cause: unknown) =>
	Effect.logError("shared widget data failed", cause).pipe(
		Effect.annotateLogs({ "maple.widget.id": widgetId, "maple.widget.kind": kind }),
		Effect.andThen(
			Effect.fail(new ShareWidgetExecutionError({ message: EXECUTION_FAILED_MESSAGE, widgetId })),
		),
	)

/**
 * Route both failures and defects for one widget into the per-widget envelope.
 *
 * Defects included, deliberately. "One broken tile must not blank its
 * neighbours" is this endpoint's design property, and a defect — a driver
 * throwing on an unexpected row shape, say — blanks the entire batch with a 500
 * if it escapes, which is precisely the outcome the envelope exists to prevent.
 * Interruption still propagates: `catch` and `catchDefect` leave it alone, which
 * is why neither is `catchCause`.
 */
const asWidgetOutcomeFailure =
	(widgetId: string, kind: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ShareWidgetExecutionError, R> =>
		effect.pipe(
			Effect.catch(executionFailed(widgetId, kind)),
			Effect.catchDefect(executionFailed(widgetId, kind)),
		)

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
	/**
	 * The tile's rendered width in points, as the signed-in board sends. Handed
	 * to `planWidgetRequest`, which attaches it to timeseries requests only.
	 */
	readonly maxDataPoints?: number
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

/**
 * The interpolated query-set params, read back as typed values.
 *
 * `planWidgetRequest` returns an untyped bag (interpolation rebuilds every
 * object), so this is the boundary check — the same one the browser's
 * `getQueryBuilderTimeseries` performs on the identical payload before running
 * the same runner.
 */
const PlannedQuerySetParams = Schema.Struct({
	...QuerySetSchema.fields,
	defaultLimit: Schema.optionalKey(Schema.Number),
	limit: Schema.optionalKey(Schema.Number),
	columns: Schema.optionalKey(Schema.Array(Schema.String)),
	strategy: Schema.optionalKey(
		Schema.Struct({
			enableEmptyRangeFallback: Schema.optionalKey(Schema.Boolean),
			fallbackWindowSeconds: Schema.optionalKey(Schema.Array(Schema.Number)),
			maxFallbackRangeSeconds: Schema.optionalKey(Schema.Number),
		}),
	),
	maxDataPoints: Schema.optionalKey(Schema.Number),
})
const decodePlannedQuerySet = Schema.decodeUnknownEffect(PlannedQuerySetParams)

const PlannedRawSqlParams = Schema.Struct({
	sql: Schema.String,
	displayType: Schema.optionalKey(Schema.String),
	granularitySeconds: Schema.optionalKey(Schema.Number),
})
const decodePlannedRawSql = Schema.decodeUnknownEffect(PlannedRawSqlParams)

/** The list cap applied to a window that exceeds it: last `MAX_LIST_RANGE_SECONDS` up to its end. */
const narrowToListCap = (window: ResolvedWindow): ResolvedWindow => ({
	startTime: formatWarehouseDateTime(
		parseWarehouseDateTime(window.endTime) - MAX_LIST_RANGE_SECONDS * 1000,
	),
	endTime: window.endTime,
})

export interface DashboardWidgetDataServiceApi {
	/**
	 * The option lists of the document's `query` variables over a window — the
	 * same facet / attribute-value queries the signed-in provider runs, so the
	 * share's "first option" and "All" expansion are the board's. A source that
	 * fails to list resolves to no options, as it does in the browser.
	 */
	readonly variableOptions: (
		orgId: OrgId,
		definitions: ReadonlyArray<DashboardVariable>,
		window: ResolvedWindow,
	) => Effect.Effect<Readonly<Record<string, ReadonlyArray<string>>>>
	readonly resolve: (
		orgId: OrgId,
		document: DashboardDocument,
		request: WidgetDataRequest,
		window: ResolvedWindow,
		variableValues: VariableValues,
	) => Effect.Effect<
		WidgetDataOutcome,
		ShareWidgetNotFoundError | ShareUnsupportedWidgetError | ShareWidgetExecutionError
	>
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

			// A markdown/static tile has nothing to fetch. It is a success with no
			// data, not an unsupported widget — the renderer draws it from the
			// document alone.
			const lowered = toWidgetRequest(dataSource)
			if (lowered === null || lowered.endpoint === MARKDOWN_STATIC_ENDPOINT) {
				return {
					widgetId: request.widgetId,
					source: request.source,
					data: null,
				} satisfies WidgetDataOutcome
			}

			// The signed-in browser's exact planning pass. A pinned tile
			// (`widget.timeRange`) resolves against the same clock and snap grid
			// the browser uses; the batch window is the fallback, not the rule.
			const plan = planWidgetRequest({
				request: lowered,
				dashboardWindow: window,
				...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
				variableValues,
				...(request.maxDataPoints === undefined
					? undefined
					: { maxDataPoints: request.maxDataPoints }),
			})
			if (plan.kind === "disabled") {
				return yield* Effect.fail(
					new ShareWidgetExecutionError({
						message:
							plan.reason === "metric_not_selected"
								? "This widget has no metric selected."
								: "This widget's own time range couldn't be resolved.",
						widgetId: request.widgetId,
					}),
				)
			}

			// A pinned range is the author's, not the viewer's, but it still has to
			// respect the share ceiling — a 90-day tile is refused here for the same
			// reason a 90-day batch window is refused at the route.
			if (widget.timeRange !== undefined) {
				yield* resolveShareWindow(plan.window).pipe(
					Effect.mapError(
						(error) =>
							new ShareWidgetExecutionError({
								message: error.message,
								widgetId: request.widgetId,
							}),
					),
				)
			}

			// Clamp before executing. A list-shaped tile scans raw rows, so a viewer
			// dragging the picker to 30 days would otherwise issue a scan the signed-in
			// UI refuses. The authed app offers an opt-in "narrow" button; a chrome-less
			// viewer has nowhere to put one, so the server narrows and says so — by
			// re-planning over the capped window, exactly what that button does.
			const executed: PlannedWidgetRequest = plan.exceedsListCap
				? (() => {
						const narrowed = planWidgetRequest({
							request: lowered,
							dashboardWindow: narrowToListCap(plan.window),
							variableValues,
							...(request.maxDataPoints === undefined
								? undefined
								: { maxDataPoints: request.maxDataPoints }),
						})
						return narrowed.kind === "request" ? narrowed : plan
					})()
				: plan
			const narrowedFields = plan.exceedsListCap
				? { narrowedToSeconds: MAX_LIST_RANGE_SECONDS }
				: undefined
			const outcome = (data: unknown): WidgetDataOutcome => ({
				widgetId: request.widgetId,
				source: request.source,
				data,
				...narrowedFields,
			})

			// `{ data: rows }` in every branch — the envelope the browser's server
			// functions return, which the shared `toReadyWidgetData` unwraps on
			// the client for both paths alike.
			const querySet = dataSourceQuerySet(dataSource)
			if (querySet !== null && executed.endpoint === QUERY_RESULT_ENDPOINTS[querySet.resultShape]) {
				const rows = yield* Effect.gen(function* () {
					const params = yield* decodePlannedQuerySet(executed.params)
					const result = yield* runQuerySet(makeServerQuerySetExecutor(tenant, queryEngine), {
						querySet: {
							queries: params.queries,
							...(params.formulas === undefined ? undefined : { formulas: params.formulas }),
							...(params.comparison === undefined
								? undefined
								: { comparison: params.comparison }),
						},
						resultShape: querySet.resultShape,
						startTime: executed.window.startTime,
						endTime: executed.window.endTime,
						...(params.defaultLimit === undefined
							? undefined
							: { defaultLimit: params.defaultLimit }),
						...(params.limit === undefined ? undefined : { limit: params.limit }),
						...(params.columns === undefined ? undefined : { columns: params.columns }),
						fallback: fallbackStrategyFromWire(params.strategy),
						...(params.maxDataPoints === undefined
							? undefined
							: { maxDataPoints: params.maxDataPoints }),
					})
					return result.rows
				}).pipe(
					// A query set that fails still rides inside the batch — one broken
					// tile on a shared board must not blank its neighbours — but as a
					// retryable failure, not as "unsupported". The query set is supported;
					// this run of it did not work.
					asWidgetOutcomeFailure(request.widgetId, "query"),
				)
				return outcome({ data: rows })
			}

			if (executed.endpoint === RAW_SQL_ENDPOINT) {
				// The SQL is the dashboard author's, never the viewer's — it comes off
				// the stored document and no share payload can influence it beyond
				// the variable values, which the planner interpolated as escaped SQL
				// literals. It still goes through `makeExecuteRawSql`, the same
				// macro-expanding, org-filter-enforcing path the signed-in route uses,
				// with the same `$__interval_s` policy and the same time-series
				// reshaping, so the tile is byte-identical to the board's.
				const rows = yield* Effect.gen(function* () {
					const params = yield* decodePlannedRawSql(executed.params)
					const executeRawSql = makeExecuteRawSql<
						TenantContext,
						WarehouseExecutionError | RawSqlValidationError
					>(warehouse)
					const result = yield* executeRawSql(tenant, {
						sql: params.sql,
						orgId: tenant.orgId,
						startTime: executed.window.startTime,
						endTime: executed.window.endTime,
						granularitySeconds:
							params.granularitySeconds ??
							computeBucketSecondsForRange(
								executed.window.startTime,
								executed.window.endTime,
								"rawSql",
							),
						workload: "interactive",
						context: "rawSql",
					})
					return rawSqlRowsForDisplay(result.rows, params.displayType)
				}).pipe(asWidgetOutcomeFailure(request.widgetId, "raw_sql"))
				return outcome({ data: rows })
			}

			const routePlan = ROUTE_ENDPOINT_PLANS[executed.endpoint]
			if (routePlan === undefined) {
				return yield* Effect.fail(
					new ShareUnsupportedWidgetError({
						message: UNSUPPORTED_WIDGET_MESSAGE,
						widgetId: request.widgetId,
						kind: executed.endpoint,
					}),
				)
			}

			const context: RouteEndpointContext = {
				tenant,
				queryEngine,
				warehouse,
				window: executed.window,
			}

			// `routePlan === undefined` above is the structural case and stays
			// "unsupported"; a plan that exists and throws is a run that failed.
			const data = yield* routePlan
				.run(executed.params, context)
				.pipe(asWidgetOutcomeFailure(request.widgetId, executed.endpoint))

			return outcome(data)
		})

		const variableOptions = Effect.fn("DashboardWidgetDataService.variableOptions")(function* (
			orgId: OrgId,
			definitions: ReadonlyArray<DashboardVariable>,
			window: ResolvedWindow,
		) {
			const tenant = shareViewerTenant(orgId)
			// Several variables sharing a source share one query, as the browser's
			// atom family dedupes them by input.
			const byQuery = new Map<
				string,
				{ query: NonNullable<ReturnType<typeof dashboardVariableOptionsQuery>>; names: string[] }
			>()
			for (const definition of definitions) {
				const query = dashboardVariableOptionsQuery(definition)
				if (query === null) continue
				const key = JSON.stringify(query)
				const entry = byQuery.get(key) ?? { query, names: [] }
				entry.names.push(definition.name)
				byQuery.set(key, entry)
			}

			const listed = yield* Effect.forEach(
				[...byQuery.values()],
				({ query, names }) =>
					queryEngine
						.execute(tenant, { startTime: window.startTime, endTime: window.endTime, query })
						.pipe(
							Effect.map((response) =>
								dashboardVariableOptionsFromResult(query, response.result),
							),
							Effect.tapError((cause) =>
								Effect.logWarning("shared dashboard variable options failed", cause).pipe(
									Effect.annotateLogs({ "maple.variable.names": names.join(",") }),
								),
							),
							// No options is a state the browser reaches too (a failed
							// facet fetch); the ladder then falls through to "" as it
							// does there. Never fail the batch over a dropdown.
							Effect.orElseSucceed((): string[] => []),
							Effect.catchDefect(() => Effect.succeed<string[]>([])),
							Effect.map((options) => ({ names, options })),
						),
				{ concurrency: 4 },
			)

			const byName: Record<string, ReadonlyArray<string>> = {}
			for (const { names, options } of listed) {
				for (const name of names) byName[name] = options
			}
			return byName
		})

		return { variableOptions, resolve } satisfies DashboardWidgetDataServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

export type { DashboardVariable }
