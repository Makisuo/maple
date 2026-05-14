import type { RawSqlDisplayType } from "@maple/domain/http"
import type { VisualizationType } from "@/components/dashboard-builder/types"

// ---------------------------------------------------------------------------
// Default ClickHouse SQL templates per Raw SQL display type, plus the helper
// that derives a display type from a widget's visualization + chartId.
//
// Used when the user toggles a widget into Raw SQL mode for the first time —
// we seed the SQL textarea with a sensible starting query so the preview
// renders immediately.
// ---------------------------------------------------------------------------

const TIMESERIES_TEMPLATE = `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
       count() AS logs
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket`

const TABLE_TEMPLATE = `SELECT ServiceName, count() AS spans
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY ServiceName
ORDER BY spans DESC
LIMIT 20`

const STAT_TEMPLATE = `SELECT count() AS value
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)`

const PIE_TEMPLATE = `SELECT ServiceName AS name, count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY name
ORDER BY value DESC
LIMIT 8`

const HISTOGRAM_TEMPLATE = `SELECT Duration / 1000000 AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
LIMIT 5000`

const HEATMAP_TEMPLATE = `SELECT ServiceName AS x,
       toString(toHour(Timestamp)) AS y,
       count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY x, y
ORDER BY x, y`

export const RAW_SQL_TEMPLATES: Record<RawSqlDisplayType, string> = {
	line: TIMESERIES_TEMPLATE,
	area: TIMESERIES_TEMPLATE,
	bar: TIMESERIES_TEMPLATE,
	table: TABLE_TEMPLATE,
	stat: STAT_TEMPLATE,
	pie: PIE_TEMPLATE,
	histogram: HISTOGRAM_TEMPLATE,
	heatmap: HEATMAP_TEMPLATE,
}

export function visualizationToDisplayType(
	visualization: VisualizationType,
	chartId?: string,
): RawSqlDisplayType {
	switch (visualization) {
		case "table":
			return "table"
		case "stat":
			return "stat"
		case "pie":
			return "pie"
		case "histogram":
			return "histogram"
		case "heatmap":
			return "heatmap"
		case "chart":
		default:
			if (chartId?.includes("bar")) return "bar"
			if (chartId?.includes("area")) return "area"
			return "line"
	}
}
