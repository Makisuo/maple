import { QUERY_RESULT_SHAPES, QuerySetSchema } from "@maple/query-model"
import { Schema } from "effect"
import { UnknownRecord, WidgetDataSourceTransformV2 } from "../shared/transform"

/**
 * v3 data source: a discriminated union instead of an opaque params bag.
 *
 * v1 and v2 both stored `{ endpoint: string, params?: unknown }`. The endpoint
 * string carried the source's identity and `params` carried its content, which
 * meant every reader had to know which endpoint names implied which param keys
 * — a contract enforced nowhere. v3 makes both structural: `kind` says what the
 * source *is*, and each arm declares the fields that arm actually has.
 *
 * The four arms are the four things a widget can be backed by, and they were
 * always these four — v2 just spelled them as string conventions.
 */

/**
 * `transform` is on every arm, not hoisted above the union.
 *
 * It describes what to do with the *response*, so it is genuinely independent of
 * how the request is described — but hoisting it would mean
 * `Schema.Struct({ transform, ...union })`, and a struct-of-union loses the
 * discriminant narrowing that is this schema's entire point. Repeating one
 * optional field on four arms is the cheaper trade, and `ds.transform` still
 * reads directly off the union because TypeScript distributes the access.
 */
const transformField = { transform: Schema.optionalKey(WidgetDataSourceTransformV2) }

/**
 * A user-authored query set, from the query builder.
 *
 * The query-set fields are *spread*, not nested under a `querySet` key. Two
 * reasons, both load-bearing:
 *
 * 1. The shape the ~30 existing consumers already speak is flat —
 *    `WidgetQuerySet extends QuerySet` in `access.ts` — and
 *    `packages/query-engine/src/query-set/dispatch.ts` consumes that flat shape
 *    *structurally* (it deliberately does not import `@maple/widgets`). Nesting
 *    would break that structural match silently, at runtime.
 * 2. A field added to `QuerySetSchema` — shared with alert rules — reaches
 *    widgets without an edit here.
 *
 * `resultShape` is required, where `dataSourceQuerySet` used to default it to
 * `"timeseries"` for a v2 source missing it. That default now lives in exactly
 * one place, the v2 -> v3 migration, which is where a default for legacy data
 * belongs.
 */
export const QueryWidgetDataSource = Schema.Struct({
	kind: Schema.Literal("query"),
	resultShape: Schema.Literals(QUERY_RESULT_SHAPES),
	...QuerySetSchema.fields,
	/**
	 * Request shaping — how many rows to fetch and which columns.
	 *
	 * Deliberately NOT in `QuerySetSchema`: these describe the *request a widget
	 * makes*, not the query it stores, and an alert rule sharing the query set has
	 * no use for any of them. `defaultLimit` is the breakdown's
	 * fetch-past-what-you-draw allowance (only the pie collapses a long tail into
	 * "Other"); `limit`/`columns` are the list shape's row cap and projection.
	 */
	defaultLimit: Schema.optionalKey(Schema.Number),
	limit: Schema.optionalKey(Schema.Number),
	columns: Schema.optionalKey(Schema.Array(Schema.String)),
	...transformField,
}).annotate({
	identifier: "@maple/QueryWidgetDataSource",
	title: "Query widget data source",
})

/** User-authored ClickHouse SQL. */
export const RawSqlWidgetDataSource = Schema.Struct({
	kind: Schema.Literal("raw_sql"),
	// Required, unlike the v2 accessor which coerced a missing `sql` to "". An
	// empty string is still representable and still meaningful (a raw-SQL widget
	// saved before any SQL was written); an *absent* one is not.
	sql: Schema.String,
	displayType: Schema.optionalKey(Schema.String),
	granularitySeconds: Schema.optionalKey(Schema.Number),
	...transformField,
}).annotate({
	identifier: "@maple/RawSqlWidgetDataSource",
	title: "Raw SQL widget data source",
})

/**
 * One of the curated fixed routes (`service_overview`, `list_traces`, ...).
 *
 * The only arm that keeps an opaque params bag. Closing it is per-route across
 * ~20 routes and is a separate, much larger job — the point of v3 is that the
 * two arms carrying *user-authored* content are typed, which is where the
 * string-sniffing actually hurt.
 *
 * `endpoint` is `Schema.String`, deliberately open. Closing it to a literal set
 * would make a document naming a route this build doesn't know FAIL TO DECODE,
 * and `DashboardPersistenceService.parsePayload` turns a decode failure into a
 * hard error on the *writable* path — so one stale route name would lock a whole
 * dashboard out of editing. Storage stays open; the compile-time typo check
 * lives on `makeRouteDataSource`'s type parameter instead, which catches it at
 * authoring time without putting stored documents at risk.
 */
export const RouteWidgetDataSource = Schema.Struct({
	kind: Schema.Literal("route"),
	endpoint: Schema.String,
	params: Schema.optionalKey(UnknownRecord),
	...transformField,
}).annotate({
	identifier: "@maple/RouteWidgetDataSource",
	title: "Route widget data source",
})

/**
 * A widget that reads nothing — today, a markdown note.
 *
 * In v2 this was a route (`markdown_static`) with a no-op server function behind
 * it purely so the registry lookup would succeed. Making it an arm means the
 * "this widget issues no request" case is answered by the type rather than by a
 * string comparison against one magic endpoint name.
 */
export const StaticWidgetDataSource = Schema.Struct({
	kind: Schema.Literal("static"),
	...transformField,
}).annotate({
	identifier: "@maple/StaticWidgetDataSource",
	title: "Static widget data source",
})

/**
 * The discriminant values, exported so tests can assert coverage.
 *
 * `dashboard-widget-parity.test.ts` drives its public-API encoder coverage off
 * this: a fifth arm added to the union fails that test until someone decides
 * what the v2 HTTP API does with it. That is the structural successor to the
 * assignability assertions the union replaced.
 */
export const WIDGET_DATA_SOURCE_KINDS = ["query", "raw_sql", "route", "static"] as const
export type WidgetDataSourceKind = (typeof WIDGET_DATA_SOURCE_KINDS)[number]

export const WidgetDataSourceV3 = Schema.Union([
	QueryWidgetDataSource,
	RawSqlWidgetDataSource,
	RouteWidgetDataSource,
	StaticWidgetDataSource,
]).annotate({
	identifier: "@maple/WidgetDataSource",
	title: "Widget data source",
})
