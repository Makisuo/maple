import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	escapeMetricStringLiteral,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// PlanetScale branch metrics arrive via the scraper (the integration's managed
// scrape target) with PlanetScale's own Prometheus metric names, all gauges.
// The http_sd discovery labels ride along as point attributes, so widgets group
// and filter on PlanetScale's canonical `_name` discovery labels.
function databaseWhere(database?: string): string {
	return database ? `attr.planetscale_database_name = "${escapeMetricStringLiteral(database)}"` : ""
}

function gaugeChart(opts: {
	id: string
	name: string
	metricName: string
	title: string
	unit: string
	where: string
	aggregation?: string
	display?: typeof CHART_DISPLAY_AREA | typeof CHART_DISPLAY_LINE
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "chart",
		dataSource: metricsTimeseries({
			id: opts.id,
			name: opts.name,
			metricName: opts.metricName,
			metricType: "gauge",
			aggregation: opts.aggregation ?? "max",
			whereClause: opts.where,
			groupBy: ["attr.planetscale_database_name"],
		}),
		display: { title: opts.title, ...(opts.display ?? CHART_DISPLAY_LINE), unit: opts.unit },
		layout: opts.layout,
	}
}

function widgets(database?: string): WidgetDef[] {
	const where = databaseWhere(database)
	return [
		{
			id: "connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "connections",
				name: "Connections",
				metricName: "planetscale_edge_active_connections",
				metricType: "gauge",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["attr.planetscale_database_name"],
			}),
			display: { title: "Active Connections (MySQL)", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "connections-postgres",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "connections-postgres",
				name: "Connections",
				metricName: "planetscale_edge_postgres_active_connections",
				metricType: "gauge",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["attr.planetscale_database_name"],
			}),
			display: { title: "Active Connections (Postgres)", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		gaugeChart({
			id: "cpu",
			name: "CPU",
			metricName: "planetscale_pods_cpu_util_percentages",
			title: "Pod CPU Utilization (max)",
			unit: "percent",
			where,
			layout: { x: 0, y: 4, w: 6, h: 4 },
		}),
		gaugeChart({
			id: "memory",
			name: "Memory",
			metricName: "planetscale_pods_mem_util_percentages",
			title: "Pod Memory Utilization (max)",
			unit: "percent",
			where,
			layout: { x: 6, y: 4, w: 6, h: 4 },
		}),
		gaugeChart({
			id: "replica-lag-mysql",
			name: "Replica lag",
			metricName: "planetscale_mysql_replica_lag_seconds",
			title: "Replica Lag (MySQL)",
			unit: "seconds",
			where,
			layout: { x: 0, y: 8, w: 6, h: 4 },
		}),
		gaugeChart({
			id: "replica-lag-postgres",
			name: "Replica lag",
			metricName: "planetscale_postgres_replica_lag_seconds",
			title: "Replica Lag (Postgres)",
			unit: "seconds",
			where,
			layout: { x: 6, y: 8, w: 6, h: 4 },
		}),
		{
			id: "queries-by-branch",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "queries-by-branch",
				name: "Connections by branch",
				metricName: "planetscale_edge_active_connections",
				metricType: "gauge",
				aggregation: "sum",
				whereClause: combineWhere(where),
				groupBy: ["attr.planetscale_branch_name"],
			}),
			display: { title: "Connections by Branch", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 4 },
		},
		gaugeChart({
			id: "storage-available",
			name: "Storage available",
			metricName: "planetscale_volume_available_bytes",
			title: "Volume Available (Postgres)",
			unit: "bytes",
			where,
			aggregation: "min",
			layout: { x: 6, y: 12, w: 6, h: 4 },
		}),
	]
}

export const planetscaleTemplate: TemplateDefinition = {
	id: templateId("planetscale"),
	name: "PlanetScale Databases",
	description:
		"Database health from the PlanetScale integration — active connections, pod CPU/memory utilization, replication lag, and per-branch breakdowns from the scraped branch metrics.",
	category: "infrastructure",
	tags: ["planetscale", "database", "mysql", "postgres"],
	requirements: ["PlanetScale integration connected (or a planetscale scrape target)"],
	requiredMetricPrefixes: ["planetscale_"],
	parameters: [
		{
			key: paramKey("database"),
			label: "Database",
			description: "Optional — scope every widget to a single PlanetScale database.",
			required: false,
			placeholder: "my-database",
		},
	],
	build: (params) => {
		const database = paramValue(params, "database")
		return buildPortableDashboard({
			name: database ? `${database} — PlanetScale` : "PlanetScale Databases",
			description:
				"PlanetScale branch metrics — connections, CPU, memory, replication lag, and storage.",
			tags: ["planetscale"],
			timeRange: "24h",
			widgets: widgets(database),
		})
	},
}
