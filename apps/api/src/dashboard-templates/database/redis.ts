import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
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
			layout: { x: 0, y: 0, w: 6, h: 6 },
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
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		{
			// Hits and misses are the two halves of every keyspace lookup, so they belong on one
			// stacked chart (total lookups, split by outcome) rather than two charts nobody can
			// visually divide.
			id: "keyspace",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "redis-hits",
					name: "Hits",
					dataSource: "metrics",
					aggregation: "rate",
					isMonotonic: true,
					whereClause: where,
					metricName: "redis.keyspace.hits",
					metricType: "sum",
				}),
				makeQueryDraft({
					id: "redis-misses",
					name: "Misses",
					dataSource: "metrics",
					aggregation: "rate",
					isMonotonic: true,
					whereClause: where,
					metricName: "redis.keyspace.misses",
					metricType: "sum",
				}),
			]),
			display: { title: "Keyspace Hits / Misses per sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			// The number people actually act on. `unit: "percent"` is a 0–1 ratio, so no `* 100`.
			id: "keyspace-hit-rate",
			visualization: "chart",
			dataSource: {
				endpoint: "custom_query_builder_timeseries",
				params: {
					queries: [
						{
							...makeQueryDraft({
								id: "redis-hit-rate-hits",
								name: "A",
								dataSource: "metrics",
								aggregation: "rate",
								isMonotonic: true,
								whereClause: where,
								metricName: "redis.keyspace.hits",
								metricType: "sum",
							}),
							hidden: true,
						},
						{
							...makeQueryDraft({
								id: "redis-hit-rate-misses",
								name: "B",
								dataSource: "metrics",
								aggregation: "rate",
								isMonotonic: true,
								whereClause: where,
								metricName: "redis.keyspace.misses",
								metricType: "sum",
							}),
							hidden: true,
						},
					],
					formulas: [
						{
							id: "redis-hit-rate",
							name: "Keyspace hit rate",
							expression: "A / (A + B)",
							legend: "hit rate",
						},
					],
					comparison: { mode: "none", includePercentChange: true },
					debug: false,
				},
			},
			display: { title: "Keyspace Hit Rate", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			id: "connected-clients",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "redis-clients",
				name: "Connected Clients",
				metricName: "redis.clients.connected",
				metricType: "sum",
				aggregation: "avg",
				isMonotonic: false,
				whereClause: where,
			}),
			display: { title: "Connected Clients", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 6 },
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
			display: { title: "Evictions / sec", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 6, y: 12, w: 6, h: 6 },
		},
	]
}

export const redisTemplate: TemplateDefinition = {
	id: templateId("redis-overview"),
	name: "Redis Overview",
	description: "Commands/sec, memory, keyspace hits/misses and hit rate, connected clients, and evictions.",
	category: "database",
	tags: ["redis", "cache"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry redisreceiver",
		collector: "the OpenTelemetry redisreceiver",
		setupLabel: "the Redis receiver",
		hint: "Point it at your Redis instances and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["redis."],
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
