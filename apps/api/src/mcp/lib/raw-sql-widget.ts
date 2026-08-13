import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import type { RawSqlDisplayType, WidgetDataSourceSchema } from "@maple/domain/http"
import { makeRawSqlDataSource } from "@maple/widgets/dashboard"

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
		...(args.granularitySeconds == null ? {} : { granularitySeconds: args.granularitySeconds }),
		// A scalar widget needs a reduceToValue transform so the tile reads
		// `data[0].value`. Mirrors buildRawSqlDataSource in the web app.
		...(widgetTypeByVisualization(args.visualization)?.isScalar === true
			? { transform: { reduceToValue: { field: "value", aggregate: "first" } } }
			: {}),
	})
}

export function validateRawSqlMacro(sql: string): string | null {
	if (!sql.includes("$__orgFilter")) {
		return "Raw SQL must reference $__orgFilter so the query is scoped to your org. Add `WHERE $__orgFilter` (or `AND $__orgFilter`) to the query."
	}
	return null
}
