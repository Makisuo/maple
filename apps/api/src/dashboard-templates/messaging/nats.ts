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
			id: "connections",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "nats-connections",
				name: "Connections",
				metricName: "nats.connections",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Active Connections", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "messages-in",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "nats-msg-in",
				name: "Messages In",
				metricName: "nats.in.msgs",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Messages In / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "messages-out",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "nats-msg-out",
				name: "Messages Out",
				metricName: "nats.out.msgs",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
			}),
			display: { title: "Messages Out / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "slow-consumers",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "nats-slow",
				name: "Slow Consumers",
				metricName: "nats.slow_consumers",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Slow Consumers", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "subscriptions",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "nats-subs",
				name: "Subscriptions",
				metricName: "nats.subscriptions",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Subscriptions", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 8, w: 12, h: 4 },
		},
	]
}

export const natsTemplate: TemplateDefinition = {
	id: templateId("nats-overview"),
	name: "NATS Overview",
	description: "Connections, in/out message rates, slow consumers, and subscriptions.",
	category: "messaging",
	tags: ["nats", "messaging"],
	requirements: ["NATS Prometheus exporter via prometheusreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific NATS server by service.name.",
			required: false,
			placeholder: "nats-prod",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — NATS` : "NATS Overview",
			description: "NATS health — connections, throughput, slow consumers, subscriptions.",
			tags: ["nats"],
			widgets: widgets(serviceName),
		})
	},
}
