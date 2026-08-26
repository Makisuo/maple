import { rawSqlIssue } from "@maple/domain/raw-sql"
import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import type { RawSqlDisplayType, WidgetDataSourceSchema } from "@maple/domain/http"
import { dataSourceQuerySet, dataSourceTransform, makeRawSqlDataSource } from "@maple/widgets/dashboard"

// MCP-side mirror of the web's raw-SQL widget builder so agents can create
// raw-SQL widgets without hand-crafting the dataSource JSON.
//
// The visualization → display-type mapping used to be duplicated here and in
// apps/web/src/lib/raw-sql/templates.ts. Both now read `rawSqlDisplayTypeFor`
// from the shared widget-type table, so only `buildRawSqlDataSource` (which
// mirrors widget-query-builder-page.tsx) still has a web-side twin.

type WidgetDataSource = typeof WidgetDataSourceSchema.Type

export { rawSqlDisplayTypeFor as visualizationToDisplayType }

export function buildRawSqlDataSource(args: {
	visualization: string
	sql: string
	displayType: RawSqlDisplayType
	granularitySeconds?: number
}): WidgetDataSource {
	return makeRawSqlDataSource({
		sql: args.sql,
		displayType: args.displayType,
		...(!(args.granularitySeconds == null) ? { granularitySeconds: args.granularitySeconds } : undefined),
		// A scalar widget needs a reduceToValue transform so the tile reads
		// `data[0].value`. Mirrors buildRawSqlDataSource in the web app.
		...(widgetTypeByVisualization(args.visualization)?.isScalar === true
			? {
					transform: { reduceToValue: { field: "value", aggregate: "first" } },
				}
			: undefined),
	})
}

/**
 * Give a scalar panel the `reduceToValue` transform it needs, if it has none.
 *
 * A stat or gauge reads `data[0].value`; handed a query result it renders
 * `[object Object]`. The raw-SQL path has always injected this (above); the
 * structured-query path never did, so every MCP-authored stat and gauge built
 * from a query set was broken unless the caller happened to know about a
 * transform no tool description mentioned.
 *
 * `first` matches the raw-SQL injection: it reads the leading row rather than
 * aggregating across buckets, which is what a "current value" tile means. A
 * caller that wants a sum over the window sets `reduceToValue` explicitly, and
 * this leaves it alone.
 */
export function withScalarReduction(dataSource: WidgetDataSource, isScalar: boolean): WidgetDataSource {
	if (!isScalar) return dataSource
	if (dataSourceTransform(dataSource)?.reduceToValue !== undefined) return dataSource
	const querySet = dataSourceQuerySet(dataSource)
	// Only the query arm: a route source owns its own response shape, and a
	// static source has no response at all.
	if (querySet === null) return dataSource

	const existing = dataSourceTransform(dataSource)
	return {
		...dataSource,
		transform: { ...existing, reduceToValue: { field: "value", aggregate: "first" } },
	} as WidgetDataSource
}

/**
 * Static raw-SQL validation for the widget tools.
 *
 * Delegates to the shared `rawSqlIssue` — this used to check `$__orgFilter` and
 * nothing else, so an agent could save a widget whose SQL was deny-listed, held
 * a SETTINGS clause, or was several statements, and it failed only when someone
 * opened the dashboard.
 */
export function validateRawSql(sql: string): string | null {
	const issue = rawSqlIssue(sql)
	if (issue === null) return null
	return issue.code === "MissingOrgFilter"
		? `${issue.message} Add \`WHERE $__orgFilter\` (or \`AND $__orgFilter\`) to the query.`
		: issue.message
}
