import {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	QUERY_RESULT_ENDPOINTS,
	RAW_SQL_ENDPOINT,
} from "./access"

/**
 * A stored data source lowered to "which endpoint, with which params".
 *
 * `endpoint` is the transport identity every host dispatches on — the browser's
 * `serverFunctionMap`, the share API's resolver, the atom-family cache key —
 * and `params` is the un-interpolated bag those hosts hand to
 * `planWidgetRequest` (`@maple/query-engine`) for the time-macro / variable /
 * window pass.
 */
export interface WidgetRequest {
	readonly endpoint: string
	readonly params: Record<string, unknown>
}

/**
 * A stored data source, resolved to the request the fetch layer sends.
 *
 * The single place that turns "what this widget is" into "which server
 * function, with which params" — for the signed-in browser and for the share
 * API alike. It lived in the web app until the share resolver grew its own
 * near-copy and the two disagreed about which params a query-set widget sends;
 * a shared board then answered a different question than the board it shared.
 * Both hosts now lower through this one function and dispatch on the string
 * it returns.
 *
 * It is also the one function the v3 flip touches on the read path: a
 * `kind: "query"` data source has no endpoint of its own, so its result shape is
 * mapped onto the endpoint that already serves that shape. Returns null for a
 * data source nothing can serve, which the caller reports as a disabled tile
 * rather than a failed fetch.
 */
export function toWidgetRequest(dataSource: unknown): WidgetRequest | null {
	const rawSql = dataSourceRawSql(dataSource)
	if (rawSql !== null) {
		return {
			endpoint: RAW_SQL_ENDPOINT,
			params: {
				sql: rawSql.sql,
				...(!(rawSql.displayType === undefined) ? { displayType: rawSql.displayType } : undefined),
				...(!(rawSql.granularitySeconds === undefined)
					? {
							granularitySeconds: rawSql.granularitySeconds,
						}
					: undefined),
			},
		}
	}

	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null) {
		return {
			endpoint: QUERY_RESULT_ENDPOINTS[querySet.resultShape],
			params: {
				queries: querySet.queries,
				...(!(querySet.formulas === undefined) ? { formulas: querySet.formulas } : undefined),
				...(!(querySet.comparison === undefined) ? { comparison: querySet.comparison } : undefined),
				...(!(querySet.defaultLimit === undefined)
					? { defaultLimit: querySet.defaultLimit }
					: undefined),
				...(!(querySet.limit === undefined) ? { limit: querySet.limit } : undefined),
				...(!(querySet.columns === undefined) ? { columns: querySet.columns } : undefined),
			},
		}
	}

	const endpoint = dataSourceEndpoint(dataSource)
	if (endpoint === null) return null
	return { endpoint, params: dataSourceRouteParams(dataSource) ?? {} }
}
