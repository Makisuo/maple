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
	const groupBy = ["attr.postgresql_database_name"]
	return [
		{
			id: "active-connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-backends",
				name: "Active Connections",
				metricName: "postgresql.backends",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Active Connections", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "commits-rollbacks",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-commits",
				name: "Commits / sec",
				metricName: "postgresql.commits",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Commits per sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "blocks-read",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-blocks-read",
				name: "Blocks Read",
				metricName: "postgresql.blocks_read",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Disk Blocks Read / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "db-size",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-db-size",
				name: "DB Size",
				metricName: "postgresql.db_size",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Database Size", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "deadlocks",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-deadlocks",
				name: "Deadlocks",
				metricName: "postgresql.deadlocks",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Deadlocks / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 8, w: 6, h: 4 },
		},
		{
			id: "replication-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-replication-lag",
				name: "Replication Lag",
				metricName: "postgresql.replication.data_delay",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Replication Lag", ...CHART_DISPLAY_LINE, unit: "duration_s" },
			layout: { x: 6, y: 8, w: 6, h: 4 },
		},
	]
}

export const postgresTemplate: TemplateDefinition = {
	id: templateId("postgres-overview"),
	name: "Postgres Overview",
	description: "Connections, commits, block I/O, DB size, deadlocks, and replication lag.",
	category: "database",
	tags: ["postgres", "database"],
	requirements: ["OpenTelemetry postgresreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific Postgres instance by service.name.",
			required: false,
			placeholder: "postgres-primary",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — Postgres` : "Postgres Overview",
			description: "Postgres health — connections, throughput, I/O, and replication.",
			tags: ["postgres"],
			widgets: widgets(serviceName),
		})
	},
}
