import type { QueryResultShape, QuerySet } from "@maple/query-model"
import { QUERY_SHAPE_ENDPOINTS, RAW_SQL_ENDPOINT, type RawSqlDataSource } from "./access"
import type { WidgetDataSourceTransformV2 } from "./shared/transform"
import type { WidgetDataSourceV2 } from "./v2/data-source"

/**
 * Writing a widget's data source without caring which schema version stores it.
 *
 * The mirror of `access.ts`. Those accessors let readers move off the raw
 * `{ endpoint, params }` shape; these constructors do the same for writers —
 * dashboard templates, the Perses importer and the MCP widget builders all hand
 * a *meaning* ("a timeseries query set", "some raw SQL") to a function instead of
 * hand-assembling an endpoint string and an untyped bag.
 *
 * While `CURRENT_DASHBOARD_SCHEMA_VERSION` is 2 these emit `{ endpoint, params }`.
 * At the flip they emit the typed v3 union and no call site changes. The
 * round-trip tests in `construct.test.ts` are what hold that promise: every
 * constructor's output must read back through the matching accessor unchanged.
 */

type WidgetDataSource = typeof WidgetDataSourceV2.Type
type WidgetDataSourceTransform = typeof WidgetDataSourceTransformV2.Type

export interface QueryDataSourceInput extends QuerySet {
	readonly resultShape: QueryResultShape
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
 * The endpoint stays a literal in the return type rather than widening to
 * `string`: the web app narrows `WidgetDataSource["endpoint"]` to its registry's
 * key union so `serverFunctionMap` is statically total, and a widened `string`
 * would make every call site here unassignable to it.
 */
export const makeQueryDataSource = <S extends QueryResultShape>(
	input: QueryDataSourceInput & { readonly resultShape: S },
): WidgetDataSource & { endpoint: (typeof QUERY_SHAPE_ENDPOINTS)[S] } => ({
	endpoint: QUERY_SHAPE_ENDPOINTS[input.resultShape],
	params: {
		queries: input.queries,
		// Absent rather than empty when the caller has none: `dataSourceQuerySet`
		// reads both as "no formulas", and writing the empty key back would make a
		// widget that never had formulas indistinguishable from one that lost them.
		...(input.formulas === undefined ? {} : { formulas: input.formulas }),
		...(input.comparison === undefined ? {} : { comparison: input.comparison }),
		...(input.defaultLimit === undefined ? {} : { defaultLimit: input.defaultLimit }),
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.columns === undefined ? {} : { columns: input.columns }),
	},
	...(input.transform === undefined ? {} : { transform: input.transform }),
})

export interface RawSqlDataSourceInput extends RawSqlDataSource {
	readonly transform?: WidgetDataSourceTransform
}

/** A widget backed by user-authored ClickHouse SQL. */
export const makeRawSqlDataSource = (
	input: RawSqlDataSourceInput,
): WidgetDataSource & { endpoint: typeof RAW_SQL_ENDPOINT } => ({
	endpoint: RAW_SQL_ENDPOINT,
	params: {
		sql: input.sql,
		...(input.displayType === undefined ? {} : { displayType: input.displayType }),
		...(input.granularitySeconds === undefined ? {} : { granularitySeconds: input.granularitySeconds }),
	},
	...(input.transform === undefined ? {} : { transform: input.transform }),
})

/**
 * A widget backed by one of the curated fixed routes (`service_overview`, …).
 *
 * These keep an endpoint name and an opaque params bag in v3 too — the bag is
 * per-route and closing it is a separate, much larger job — so this constructor
 * exists for symmetry and to give the sweep one shape to grep for, not because
 * the call site would otherwise break at the flip.
 */
export const makeRouteDataSource = <E extends string>(
	endpoint: E,
	params?: Record<string, unknown>,
	transform?: WidgetDataSourceTransform,
): WidgetDataSource & { endpoint: E } => ({
	endpoint,
	...(params === undefined ? {} : { params }),
	...(transform === undefined ? {} : { transform }),
})
