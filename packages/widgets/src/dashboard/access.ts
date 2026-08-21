import type { QuerySet, QueryResultContract } from "@maple/query-model"
import { QUERY_ENDPOINT_RESULT_KINDS, RAW_SQL_ENDPOINT } from "./legacy-endpoints"
import type { WidgetDataSourceTransformV2 } from "./shared/transform"

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

const isString = (value: unknown): value is string => typeof value === "string"

// The endpoint tables moved to `legacy-endpoints.ts` — they are wire
// vocabularies rather than schema, and they outlive this file, which is deleted
// once v3 is the only stored shape. Re-exported here so the ~30 consumers that
// import them from `access.ts` today keep working until then.
export { QUERY_RESULT_ENDPOINTS, RAW_SQL_ENDPOINT } from "./legacy-endpoints"

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

/**
 * The client-side result reshaping (`reduceToValue`, `hideSeries`, `limit`, …).
 *
 * Version-independent by construction: `transform` describes what to do with the
 * *response*, so it sits beside the data source's query on v2 and on every v3
 * arm alike. The accessor exists anyway because `construct.ts` writes this field
 * and readers were reaching for it by hand — an asymmetry that would go
 * unnoticed until the one version where it stops being true.
 *
 * NOT validated, like every accessor here: a stored transform with a reducer
 * name the runtime dropped still reads back, and `applyTransform` falls through
 * to its documented default rather than the tile failing to render.
 */
export const dataSourceTransform = (
	dataSource: unknown,
): typeof WidgetDataSourceTransformV2.Type | undefined => {
	if (!isRecord(dataSource)) return undefined
	return isRecord(dataSource.transform)
		? (dataSource.transform as typeof WidgetDataSourceTransformV2.Type)
		: undefined
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
export interface WidgetQuerySet extends QuerySet {
	readonly resultShape: QueryResultContract
	/** Request shaping — see `QueryDataSourceInput` in `construct.ts`. */
	readonly defaultLimit?: number
	readonly limit?: number
	readonly columns?: ReadonlyArray<string>
}

export const dataSourceQuerySet = (dataSource: unknown): WidgetQuerySet | null => {
	if (!isRecord(dataSource)) return null

	const source = (() => {
		if (isString(dataSource.kind)) {
			if (dataSource.kind !== "query") return null
			const resultKind = dataSource.resultShape
			return {
				resultShape:
					typeof resultKind === "string" ? (resultKind as QueryResultContract) : "timeseries",
				fields: dataSource,
			}
		}
		const endpoint = dataSource.endpoint
		if (typeof endpoint !== "string") return null
		const resultKind = QUERY_ENDPOINT_RESULT_KINDS[endpoint]
		if (resultKind === undefined) return null
		return { resultShape: resultKind, fields: isRecord(dataSource.params) ? dataSource.params : {} }
	})()
	if (source === null) return null

	const { resultShape: resultKind, fields } = source
	return {
		resultShape: resultKind,
		queries: Array.isArray(fields.queries) ? (fields.queries as QuerySet["queries"]) : [],
		formulas: Array.isArray(fields.formulas) ? (fields.formulas as QuerySet["formulas"]) : undefined,
		comparison: isRecord(fields.comparison) ? (fields.comparison as QuerySet["comparison"]) : undefined,
		defaultLimit: typeof fields.defaultLimit === "number" ? fields.defaultLimit : undefined,
		limit: typeof fields.limit === "number" ? fields.limit : undefined,
		columns: Array.isArray(fields.columns) ? (fields.columns as ReadonlyArray<string>) : undefined,
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
		if (isString(dataSource.kind)) {
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
