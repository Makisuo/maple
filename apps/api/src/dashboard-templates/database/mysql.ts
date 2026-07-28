import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	metricsTimeseries,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// The mysqlreceiver reports its level metrics — threads, buffer pool, replica lag — as
// non-monotonic Sums (UpDownCounters), not Gauges. `metricType` picks the warehouse table, so
// charting one as `gauge` reads `metrics_gauge` and renders an empty widget.
function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	return [
		{
			id: "queries-per-sec",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-queries",
				name: "Queries / sec",
				metricName: "mysql.commands",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.command"],
			}),
			display: { title: "Queries by Command", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
		{
			id: "active-connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-threads",
				name: "Threads",
				metricName: "mysql.threads",
				metricType: "sum",
				aggregation: "avg",
				isMonotonic: false,
				whereClause: where,
				groupBy: ["attr.kind"],
			}),
			display: { title: "Threads", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		{
			// clean + dirty are the two halves of one pool, so they stack.
			id: "buffer-pool",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-buffer-pool",
				name: "Buffer Pool",
				metricName: "mysql.buffer_pool.usage",
				metricType: "sum",
				aggregation: "avg",
				isMonotonic: false,
				whereClause: where,
				groupBy: ["attr.status"],
			}),
			display: { title: "Buffer Pool Usage", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			id: "slow-queries",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-slow",
				name: "Slow Queries",
				metricName: "mysql.query.slow.count",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Slow Queries / sec", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			id: "table-locks",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-locks",
				name: "Table Locks",
				metricName: "mysql.locks",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.kind"],
			}),
			display: { title: "Table Locks / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 6 },
		},
		{
			id: "replica-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-replica-lag",
				name: "Replica Lag",
				metricName: "mysql.replica.time_behind_source",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
			}),
			display: { title: "Replica Lag", ...CHART_DISPLAY_LINE, unit: "duration_s" },
			layout: { x: 6, y: 12, w: 6, h: 6 },
		},
	]
}

export const mysqlTemplate: TemplateDefinition = {
	id: templateId("mysql-overview"),
	name: "MySQL Overview",
	description: "Queries by command, threads, buffer pool, slow queries, locks, and replica lag.",
	category: "database",
	tags: ["mysql", "database"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry mysqlreceiver",
		collector: "the OpenTelemetry mysqlreceiver",
		setupLabel: "the MySQL receiver",
		hint: "Point it at your MySQL instances and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["mysql."],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific MySQL instance.",
			required: false,
			placeholder: "mysql-primary",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — MySQL` : "MySQL Overview",
			description: "MySQL health — queries, threads, buffer pool, slow queries, locks, replication.",
			tags: ["mysql"],
			widgets: widgets(serviceName),
		})
	},
}
