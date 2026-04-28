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
	const groupBy = ["attr.operation"]
	return [
		{
			id: "ops-by-type",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mongo-ops",
				name: "Operations / sec",
				metricName: "mongodb.operation.count",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Operations by Type", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "active-connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mongo-connections",
				name: "Active Connections",
				metricName: "mongodb.connection.count",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Active Connections", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "document-ops",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mongo-doc-ops",
				name: "Document Ops",
				metricName: "mongodb.document.operation.count",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Document Operations / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "cache-hits",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mongo-cache",
				name: "Cache Hits",
				metricName: "mongodb.cache.operations",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.type"],
			}),
			display: { title: "Cache Hits/Misses", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "replica-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "mongo-replica-lag",
				name: "Replica Lag",
				metricName: "mongodb.replication.lag",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Replica Lag", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
			layout: { x: 0, y: 8, w: 12, h: 4 },
		},
	]
}

export const mongodbTemplate: TemplateDefinition = {
	id: templateId("mongodb-overview"),
	name: "MongoDB Overview",
	description: "Operations by type, connections, document ops, cache hits, and replica lag.",
	category: "database",
	tags: ["mongodb", "database"],
	requirements: ["OpenTelemetry mongodbreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific MongoDB instance.",
			required: false,
			placeholder: "mongodb-primary",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — MongoDB` : "MongoDB Overview",
			description: "MongoDB health — ops, connections, document throughput, cache, and replication.",
			tags: ["mongodb"],
			widgets: widgets(serviceName),
		})
	},
}
