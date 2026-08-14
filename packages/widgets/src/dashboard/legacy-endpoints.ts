import type { QueryResultShape } from "@maple/query-model"

/**
 * The legacy endpoint vocabulary — NOT schema.
 *
 * Before v3 a data source was `{ endpoint, params }`, and the endpoint string
 * carried the source's identity: `"custom_query_builder_timeseries"` meant "a
 * query set returning a timeseries", `"raw_sql_chart"` meant raw SQL. v3 makes
 * that identity structural (`kind` + `resultShape`), so the strings stop being
 * schema.
 *
 * They do not stop existing. Two contracts still speak them, and both outlive
 * the stored v2 shape:
 *
 * 1. The web app's server-function registry (`data-source-registry.ts`) is keyed
 *    by endpoint string, and that key is also the atom family key, the retention
 *    namespace, and the `LIST_ENDPOINTS` membership test.
 * 2. The public v2 HTTP API (`/v2/dashboards`) emits and accepts
 *    `{ endpoint, params }` and always will — a version number in a URL exists
 *    precisely so the internal shape can move without breaking published clients.
 *
 * They live in their own file, away from the schema modules, so that this
 * distinction survives contact with the next refactor: these are wire
 * vocabularies that happen to be strings, not a shape anything is stored in.
 */

/**
 * The endpoints that carried a user-authored query set, keyed by the result
 * shape that is their v3 identity.
 *
 * Canonical in this direction because the v2 API encoder writes it and the MCP
 * inspector reports it; the endpoint -> shape lookup is derived below, so the
 * two cannot drift.
 */
export const QUERY_SHAPE_ENDPOINTS = {
	timeseries: "custom_query_builder_timeseries",
	breakdown: "custom_query_builder_breakdown",
	list: "custom_query_builder_list",
} as const satisfies Record<QueryResultShape, string>

export const QUERY_ENDPOINT_SHAPES: Record<string, QueryResultShape> = Object.fromEntries(
	Object.entries(QUERY_SHAPE_ENDPOINTS).map(([shape, endpoint]) => [endpoint, shape]),
) as Record<string, QueryResultShape>

export const RAW_SQL_ENDPOINT = "raw_sql_chart"

/**
 * The one route that never had a query: a markdown note.
 *
 * It was a `route` in v2 with a no-op server function behind it, and becomes
 * `{ kind: "static" }` in v3. Named here rather than inlined because three
 * separate places have to agree on the mapping (the migration, the v2 API
 * encoder, and the web registry that stops needing a server function for it).
 */
export const MARKDOWN_STATIC_ENDPOINT = "markdown_static"
