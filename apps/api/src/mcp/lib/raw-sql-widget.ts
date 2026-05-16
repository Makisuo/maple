import type { RawSqlDisplayType, WidgetDataSourceSchema } from "@maple/domain/http"

// ---------------------------------------------------------------------------
// MCP-side mirror of the web's raw-SQL widget builder so agents can create
// raw-SQL widgets without hand-crafting the dataSource JSON.
//
// Keep this in lockstep with:
//   - apps/web/src/lib/raw-sql/templates.ts             (visualizationToDisplayType)
//   - apps/web/src/components/dashboard-builder/config/
//       widget-query-builder-page.tsx                   (buildRawSqlDataSource)
//
// Duplicating ~20 lines avoids the API depending on the web app.
// ---------------------------------------------------------------------------

type WidgetDataSource = typeof WidgetDataSourceSchema.Type

export function visualizationToDisplayType(
	visualization: string,
	chartId?: string,
): RawSqlDisplayType {
	switch (visualization) {
		case "table":
			return "table"
		case "stat":
		// Gauge widgets consume the same scalar shape as stat widgets.
		case "gauge":
			return "stat"
		case "pie":
			return "pie"
		case "histogram":
			return "histogram"
		case "heatmap":
			return "heatmap"
		default:
			if (chartId?.includes("bar")) return "bar"
			if (chartId?.includes("area")) return "area"
			return "line"
	}
}

export function buildRawSqlDataSource(args: {
	visualization: string
	sql: string
	displayType: RawSqlDisplayType
	granularitySeconds?: number
}): WidgetDataSource {
	const params: Record<string, unknown> = {
		sql: args.sql,
		displayType: args.displayType,
	}
	if (args.granularitySeconds != null) {
		params.granularitySeconds = args.granularitySeconds
	}

	const base: WidgetDataSource = {
		endpoint: "raw_sql_chart",
		params,
	}

	// Stat and gauge widgets need a reduceToValue transform so the widget reads
	// the scalar `data[0].value`. Mirrors buildRawSqlDataSource in the web app.
	if (args.visualization === "stat" || args.visualization === "gauge") {
		return {
			...base,
			transform: { reduceToValue: { field: "value", aggregate: "first" } },
		}
	}

	return base
}

export function validateRawSqlMacro(sql: string): string | null {
	if (!sql.includes("$__orgFilter")) {
		return "Raw SQL must reference $__orgFilter so the query is scoped to your org. Add `WHERE $__orgFilter` (or `AND $__orgFilter`) to the query."
	}
	return null
}
