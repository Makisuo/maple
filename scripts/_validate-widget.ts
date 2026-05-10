import { Schema } from "effect"
import { QueryBuilderTimeseriesInputSchema } from "../apps/web/src/api/tinybird/query-builder-timeseries.ts"
import { parseWhereClause } from "../packages/domain/src/where-clause.ts"

const widget = {
	id: "w0",
	visualization: "chart",
	dataSource: {
		endpoint: "custom_query_builder_timeseries",
		params: {
			queries: [
				{
					id: "q-w0",
					name: "A",
					enabled: true,
					hidden: false,
					dataSource: "traces",
					signalSource: "default",
					metricName: "",
					metricType: "gauge",
					isMonotonic: false,
					whereClause: 'service.name = "ingest"',
					aggregation: "count",
					stepInterval: "",
					orderByDirection: "desc",
					addOns: {
						groupBy: true,
						having: false,
						orderBy: false,
						limit: false,
						legend: false,
					},
					groupBy: ["maple.signal"],
					having: "",
					orderBy: "",
					limit: "",
					legend: "",
				},
			],
			formulas: [],
			comparison: { mode: "none", includePercentChange: true },
			debug: false,
		},
	},
	display: {
		title: "Ingest requests by signal",
		chartId: "query-builder-bar",
		chartPresentation: { legend: "visible" },
		stacked: true,
		curveType: "linear",
		unit: "number",
	},
	layout: { x: 0, y: 0, w: 6, h: 4 },
}

const params = widget.dataSource.params
const payload = {
	startTime: "2025-01-01 00:00:00",
	endTime: "2025-01-01 01:00:00",
	queries: params.queries,
	formulas: params.formulas,
	comparison: params.comparison,
	debug: params.debug,
}

try {
	const decoded = Schema.decodeUnknownSync(QueryBuilderTimeseriesInputSchema)(payload)
	console.log("Schema decode: OK")
	console.log("First query aggregation:", decoded.queries[0]?.aggregation)
} catch (err) {
	console.log("Schema decode FAILED:")
	console.log(err)
}

const whereResult = parseWhereClause(widget.dataSource.params.queries[0].whereClause)
console.log("\nparseWhereClause result:")
console.log("  clauses:", JSON.stringify(whereResult.clauses, null, 2))
console.log("  warnings:", JSON.stringify(whereResult.warnings, null, 2))
