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
			id: "commands-per-sec",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-cmds",
				name: "Commands / sec",
				metricName: "redis.commands.processed",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Commands / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "memory-used",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-memory",
				name: "Memory Used",
				metricName: "redis.memory.used",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Memory Used", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "keyspace-hits",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-hits",
				name: "Hits",
				metricName: "redis.keyspace.hits",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Keyspace Hits / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "keyspace-misses",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-misses",
				name: "Misses",
				metricName: "redis.keyspace.misses",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Keyspace Misses / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "connected-clients",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-clients",
				name: "Connected Clients",
				metricName: "redis.clients.connected",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Connected Clients", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 8, w: 6, h: 4 },
		},
		{
			id: "evictions",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-evictions",
				name: "Evictions",
				metricName: "redis.keys.evicted",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Evictions / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 8, w: 6, h: 4 },
		},
	]
}

export const redisTemplate: TemplateDefinition = {
	id: templateId("redis-overview"),
	name: "Redis Overview",
	description: "Commands/sec, memory, keyspace hits/misses, connected clients, and evictions.",
	category: "database",
	tags: ["redis", "cache"],
	requirements: ["OpenTelemetry redisreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific Redis instance.",
			required: false,
			placeholder: "redis-cache",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — Redis` : "Redis Overview",
			description: "Redis health — throughput, memory, keyspace, connections, and evictions.",
			tags: ["redis"],
			widgets: widgets(serviceName),
		})
	},
}
