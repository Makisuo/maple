import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	metricsTimeseries,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

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
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "active-connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-threads",
				name: "Threads",
				metricName: "mysql.threads",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.kind"],
			}),
			display: { title: "Threads", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "buffer-pool",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-buffer-pool",
				name: "Buffer Pool",
				metricName: "mysql.buffer_pool.usage",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.status"],
			}),
			display: { title: "Buffer Pool Usage", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "slow-queries",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-slow",
				name: "Slow Queries",
				metricName: "mysql.slow_queries",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Slow Queries / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
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
			layout: { x: 0, y: 8, w: 6, h: 4 },
		},
		{
			id: "replica-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mysql-replica-lag",
				name: "Replica Lag",
				metricName: "mysql.replica.time_behind_source",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Replica Lag", ...CHART_DISPLAY_LINE, unit: "duration_s" },
			layout: { x: 6, y: 8, w: 6, h: 4 },
		},
	]
}

export const mysqlTemplate: TemplateDefinition = {
	id: templateId("mysql-overview"),
	name: "MySQL Overview",
	description: "Queries by command, threads, buffer pool, slow queries, locks, and replica lag.",
	category: "database",
	tags: ["mysql", "database"],
	requirements: ["OpenTelemetry mysqlreceiver"],
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
