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

// The postgresreceiver puts database identity on the RESOURCE, not on the datapoint
// (`postgresql.database.name`), and reports its level metrics — backends, db_size — as
// non-monotonic Sums (UpDownCounters), not Gauges. `metricType` picks the warehouse table, so a
// UpDownCounter charted as `gauge` reads `metrics_gauge` and renders an empty widget.
function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	const groupBy = ["resource.postgresql.database.name"]
	return [
		{
			id: "active-connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-backends",
				name: "Active Connections",
				metricName: "postgresql.backends",
				metricType: "sum",
				aggregation: "avg",
				isMonotonic: false,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Active Connections", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
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
			layout: { x: 6, y: 0, w: 6, h: 6 },
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
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			id: "db-size",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-db-size",
				name: "DB Size",
				metricName: "postgresql.db_size",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Database Size", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
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
			display: { title: "Deadlocks / sec", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 6 },
		},
		{
			// `postgresql.replication.data_delay` is the replication backlog in BYTES, keyed by
			// replication client — not a lag in seconds. (The seconds-valued companion is
			// `postgresql.wal.delay`, which the receiver leaves disabled by default.)
			id: "replication-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "pg-replication-lag",
				name: "Replication Delay",
				metricName: "postgresql.replication.data_delay",
				metricType: "gauge",
				aggregation: "max",
				whereClause: where,
				groupBy: ["attr.replication_client"],
			}),
			display: { title: "Replication Delay (bytes behind)", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 12, w: 6, h: 6 },
		},
	]
}

export const postgresTemplate: TemplateDefinition = {
	id: templateId("postgres-overview"),
	name: "Postgres Overview",
	description: "Connections, commits, block I/O, DB size, deadlocks, and replication lag.",
	category: "database",
	tags: ["postgres", "database"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry postgresreceiver",
		collector: "the OpenTelemetry postgresreceiver",
		setupLabel: "the Postgres receiver",
		hint: "Point it at your Postgres instances and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["postgresql."],
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
