import type {
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelPopulationFilters,
	FunnelStep,
	QueryResultContract,
	QuerySet,
} from "@maple/query-model"
import type { RawSqlDataSource } from "./access"
import type { WidgetDataSourceTransformV2 } from "./shared/transform"
import type {
	QueryWidgetDataSource,
	RawSqlWidgetDataSource,
	RouteWidgetDataSource,
	StaticWidgetDataSource,
} from "./v3/data-source"

/**
 * Writing a widget's data source without caring which schema version stores it.
 *
 * The mirror of `access.ts`. Those accessors let readers move off the raw
 * `{ endpoint, params }` shape; these constructors do the same for writers —
 * dashboard templates, the Perses importer and the MCP widget builders all hand
 * a *meaning* ("a timeseries query set", "some raw SQL") to a function instead of
 * hand-assembling an endpoint string and an untyped bag.
 *
 * These now emit the typed v3 union. That switch happened here and NOWHERE ELSE:
 * the ~40 call sites — every dashboard template, the Perses importer, the MCP
 * widget builders, `widget-definitions.ts` — are untouched by the flip, because
 * they were already handing over a meaning rather than assembling a bag. That was
 * the whole point of extracting these, and it is the return on it.
 *
 * The round-trip tests in `construct.test.ts` are what hold the promise: every
 * constructor's output must read back through the matching accessor unchanged.
 */

type WidgetDataSourceTransform = typeof WidgetDataSourceTransformV2.Type

export interface QueryDataSourceInput extends QuerySet {
	readonly resultShape: QueryResultContract
	readonly transform?: WidgetDataSourceTransform
	/**
	 * Per-shape request shaping: how many rows to fetch and which columns.
	 *
	 * NOT in `QuerySet` and NOT in `@maple/query-model`, deliberately. These
	 * describe the *request* a widget makes, not the query it stores — an alert
	 * rule shares the query and has no use for any of them. They live here
	 * because the alternative is what this file exists to remove: three widget
	 * types hand-assembling a params bag to smuggle one number through.
	 *
	 * `defaultLimit` is the breakdown's fetch-past-what-you-draw allowance (only
	 * the pie collapses a long tail into "Other"); `limit`/`columns` are the list
	 * shape's row cap and projection.
	 */
	readonly defaultLimit?: number
	readonly limit?: number
	readonly columns?: ReadonlyArray<string>
}

/**
 * A widget backed by a user-authored query set.
 *
 * `resultShape` stays a type parameter rather than widening to
 * `QueryResultShape`, so a caller that passes a literal gets it back in the
 * return type. That is what lets the web app's chart picker narrow on the shape
 * it just constructed without a cast.
 */
export const makeQueryDataSource = <S extends QueryResultContract>(
	input: QueryDataSourceInput & { readonly resultShape: S },
): typeof QueryWidgetDataSource.Type & { readonly resultShape: S } => ({
	kind: "query",
	resultShape: input.resultShape,
	queries: input.queries,
	// Absent rather than empty when the caller has none: `dataSourceQuerySet`
	// reads both as "no formulas", and writing the empty key back would make a
	// widget that never had formulas indistinguishable from one that lost them.
	// Mandatory under `optionalKey`, where a present `undefined` is a decode error
	// — which is most of why these constructors still earn their place in v3.
	...(!(input.formulas === undefined) ? { formulas: input.formulas } : undefined),
	...(!(input.comparison === undefined) ? { comparison: input.comparison } : undefined),
	...(!(input.defaultLimit === undefined) ? { defaultLimit: input.defaultLimit } : undefined),
	...(!(input.limit === undefined) ? { limit: input.limit } : undefined),
	...(!(input.columns === undefined) ? { columns: input.columns } : undefined),
	...(!(input.transform === undefined) ? { transform: input.transform } : undefined),
})

export interface RawSqlDataSourceInput extends RawSqlDataSource {
	readonly transform?: WidgetDataSourceTransform
}

/** A widget backed by user-authored ClickHouse SQL. */
export const makeRawSqlDataSource = (input: RawSqlDataSourceInput): typeof RawSqlWidgetDataSource.Type => ({
	kind: "raw_sql",
	sql: input.sql,
	...(!(input.displayType === undefined) ? { displayType: input.displayType } : undefined),
	...(!(input.granularitySeconds === undefined)
		? { granularitySeconds: input.granularitySeconds }
		: undefined),
	...(!(input.transform === undefined) ? { transform: input.transform } : undefined),
})

/**
 * A widget backed by one of the curated fixed routes (`service_overview`, …).
 *
 * These keep an endpoint name and an opaque params bag in v3 too — the bag is
 * per-route and closing it is a separate, much larger job.
 *
 * `E` stays a type parameter so the literal survives into the return type. That
 * is now the ONLY compile-time check on a route name: `RouteWidgetDataSource`
 * types `endpoint` as an open `Schema.String` on purpose, because closing the
 * STORED schema would make one stale route name a decode failure that locks a
 * whole dashboard out of editing. Open in storage, checked at authoring.
 */
export const makeRouteDataSource = <E extends string>(
	endpoint: E,
	params?: Record<string, unknown>,
	transform?: WidgetDataSourceTransform,
): typeof RouteWidgetDataSource.Type & { readonly endpoint: E } => ({
	kind: "route",
	endpoint,
	...(!(params === undefined) ? { params } : undefined),
	...(!(transform === undefined) ? { transform } : undefined),
})

/**
 * A widget that issues no request at all — today, a markdown note.
 *
 * In v2 this was `makeRouteDataSource("markdown_static")`, a route pointing at a
 * no-op server function that existed only so the registry lookup would succeed.
 * The union answers "this widget fetches nothing" by its type instead.
 */
export const makeStaticDataSource = (
	transform?: WidgetDataSourceTransform,
): typeof StaticWidgetDataSource.Type => ({
	kind: "static",
	...(!(transform === undefined) ? { transform } : undefined),
})

/** The route a product-event funnel widget fetches through. */
export const PRODUCT_EVENTS_FUNNEL_ENDPOINT = "product_events_funnel"

/**
 * The stored `display.funnel` definition of a product-event funnel widget —
 * what `makeProductEventsFunnelDataSource` reads.
 */
export interface ProductEventsFunnelDefinition {
	readonly steps: ReadonlyArray<FunnelStep>
	readonly keyBy?: FunnelKeyBy
	readonly windowSeconds?: number
	/** Split the funnel by a dimension: the widget draws one bar per group per step. */
	readonly breakdownBy?: FunnelBreakdownBy
	/** Narrow the population to persons with a session matching these dimensions. */
	readonly filters?: FunnelPopulationFilters
}

/**
 * A funnel widget over `product_events`: the definition mirrored into the route
 * params, so the fetch path (`toWidgetRequest`) never has to read the display.
 * `keyBy` and `windowSeconds` are forwarded only when set; the route applies
 * the same defaults the /analytics Funnels view does. The population filters
 * are spread FLAT into the params — they are the same keys the funnel request
 * takes, so both routes decode the bag as `ProductEventsFunnelWidgetParams`
 * without re-nesting.
 */
export const makeProductEventsFunnelDataSource = (
	funnel: ProductEventsFunnelDefinition,
	transform?: WidgetDataSourceTransform,
) => {
	const filters = Object.fromEntries(
		Object.entries(funnel.filters ?? {}).filter(([, value]) => value !== undefined && value !== ""),
	)
	return makeRouteDataSource(
		PRODUCT_EVENTS_FUNNEL_ENDPOINT,
		{
			steps: funnel.steps,
			...(!(funnel.keyBy === undefined) ? { keyBy: funnel.keyBy } : undefined),
			...(!(funnel.windowSeconds === undefined) ? { windowSeconds: funnel.windowSeconds } : undefined),
			...(!(funnel.breakdownBy === undefined) ? { breakdownBy: funnel.breakdownBy } : undefined),
			...filters,
		},
		transform,
	)
}
