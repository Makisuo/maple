import type { QuerySet, QueryResultShape } from "@maple/query-model"

/**
 * Reading a widget's data source without caring which schema version wrote it.
 *
 * A v2 data source is `{ endpoint, params }` — an opaque bag naming a web-side
 * server function. A v3 one is a discriminated union whose query-carrying arms
 * are typed. Every accessor here reads BOTH, which is what lets the ~dozen
 * backend consumers (MCP tools, templates, the Perses importer, variable
 * interpolation) move off the raw shape one commit at a time, while v2 is still
 * the stored version. By the time the version flips there is nothing left
 * reaching into `params` by hand.
 *
 * Deliberately `unknown`-in: callers hold widgets typed by whichever schema
 * version their module imported, and a parameter typed to one of them would
 * just push a cast to every call site. The narrowing happens once, here.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The v2 endpoints that carried a user-authored query rather than a fixed route,
 * keyed by the result shape that is the v3 identity of the same thing.
 *
 * Canonical in this direction because `construct.ts` writes it and the MCP
 * inspector reports it; the endpoint → shape lookup below is derived, so the two
 * cannot drift.
 */
export const QUERY_SHAPE_ENDPOINTS = {
	timeseries: "custom_query_builder_timeseries",
	breakdown: "custom_query_builder_breakdown",
	list: "custom_query_builder_list",
} as const satisfies Record<QueryResultShape, string>

const QUERY_ENDPOINT_SHAPES: Record<string, QueryResultShape> = Object.fromEntries(
	Object.entries(QUERY_SHAPE_ENDPOINTS).map(([shape, endpoint]) => [endpoint, shape]),
) as Record<string, QueryResultShape>

export const RAW_SQL_ENDPOINT = "raw_sql_chart"

/**
 * The endpoint name, for consumers that still dispatch on it.
 *
 * Returns null for a v3 data source that is not a `route` — a typed `query` arm
 * has no endpoint, and inventing one (`"custom_query_builder_timeseries"`) would
 * quietly re-create the string-sniffing this refactor removes.
 */
export const dataSourceEndpoint = (dataSource: unknown): string | null => {
	if (!isRecord(dataSource)) return null
	if (typeof dataSource.kind === "string") {
		return dataSource.kind === "route" && typeof dataSource.endpoint === "string"
			? dataSource.endpoint
			: null
	}
	return typeof dataSource.endpoint === "string" ? dataSource.endpoint : null
}

/** True when this data source carries a user-authored query set. */
export const isQueryDataSource = (dataSource: unknown): boolean => dataSourceQuerySet(dataSource) !== null

/**
 * The query set, whichever way it is stored.
 *
 * Structural on v3; on v2 it reads `params.queries` for the three query-builder
 * endpoints. NOT validated — this is a read accessor, and a caller that needs
 * decoded drafts should decode. Returning a partly-malformed set is correct
 * here: the MCP inspector and the template checker both want to report on what
 * is actually stored, not on what would survive a decode.
 */
export const dataSourceQuerySet = (
	dataSource: unknown,
): (QuerySet & { resultShape: QueryResultShape }) | null => {
	if (!isRecord(dataSource)) return null

	if (typeof dataSource.kind === "string") {
		if (dataSource.kind !== "query") return null
		const shape = dataSource.resultShape
		return {
			resultShape: typeof shape === "string" ? (shape as QueryResultShape) : "timeseries",
			queries: Array.isArray(dataSource.queries) ? (dataSource.queries as QuerySet["queries"]) : [],
			formulas: Array.isArray(dataSource.formulas)
				? (dataSource.formulas as QuerySet["formulas"])
				: undefined,
			comparison: isRecord(dataSource.comparison)
				? (dataSource.comparison as QuerySet["comparison"])
				: undefined,
		}
	}

	const endpoint = dataSource.endpoint
	if (typeof endpoint !== "string") return null
	const resultShape = QUERY_ENDPOINT_SHAPES[endpoint]
	if (resultShape === undefined) return null

	const params = isRecord(dataSource.params) ? dataSource.params : {}
	return {
		resultShape,
		queries: Array.isArray(params.queries) ? (params.queries as QuerySet["queries"]) : [],
		formulas: Array.isArray(params.formulas) ? (params.formulas as QuerySet["formulas"]) : undefined,
		comparison: isRecord(params.comparison) ? (params.comparison as QuerySet["comparison"]) : undefined,
	}
}

export interface RawSqlDataSource {
	sql: string
	displayType?: string
	granularitySeconds?: number
}

/** The raw-SQL payload, from `params` on v2 and the variant's own fields on v3. */
export const dataSourceRawSql = (dataSource: unknown): RawSqlDataSource | null => {
	if (!isRecord(dataSource)) return null

	const source = (() => {
		if (typeof dataSource.kind === "string") {
			return dataSource.kind === "raw_sql" ? dataSource : null
		}
		if (dataSource.endpoint !== RAW_SQL_ENDPOINT) return null
		return isRecord(dataSource.params) ? dataSource.params : {}
	})()
	if (source === null) return null

	return {
		// An empty string is representable and meaningful — a raw-SQL widget saved
		// before any SQL was written. Callers warn about it; they don't get null.
		sql: typeof source.sql === "string" ? source.sql : "",
		displayType: typeof source.displayType === "string" ? source.displayType : undefined,
		granularitySeconds:
			typeof source.granularitySeconds === "number" ? source.granularitySeconds : undefined,
	}
}

/**
 * The opaque params bag of a curated fixed route.
 *
 * Route data sources keep an endpoint plus an untyped bag in v3 too — closing
 * that bag is per-route and a much larger job — so this is the one accessor
 * whose result stays opaque. Its caller is the widget editor's legacy fallback,
 * which reads pre-query-builder widgets (`custom_timeseries` and friends).
 *
 * Returns undefined for a query-builder or raw-SQL endpoint even on v2, where
 * the bag physically exists: those have typed accessors above, and returning the
 * bag here would give v2 an answer v3 cannot give, which is the version
 * asymmetry these accessors exist to prevent.
 */
export const dataSourceRouteParams = (dataSource: unknown): Record<string, unknown> | undefined => {
	if (!isRecord(dataSource)) return undefined
	if (typeof dataSource.kind === "string") {
		if (dataSource.kind !== "route") return undefined
	} else if (dataSourceQuerySet(dataSource) !== null || dataSourceRawSql(dataSource) !== null) {
		return undefined
	}
	return isRecord(dataSource.params) ? dataSource.params : undefined
}
