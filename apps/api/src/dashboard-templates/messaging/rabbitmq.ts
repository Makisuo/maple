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
	const queueGroup = ["attr.queue"]
	return [
		{
			id: "queue-depth",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-depth",
				name: "Queue Depth",
				metricName: "rabbitmq.message.current",
				metricType: "gauge",
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Queue Depth", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "publish-rate",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-publish",
				name: "Publish Rate",
				metricName: "rabbitmq.message.published",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Publish Rate", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "deliver-rate",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-deliver",
				name: "Deliver Rate",
				metricName: "rabbitmq.message.delivered",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Deliver Rate", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "consumers",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-consumers",
				name: "Consumers",
				metricName: "rabbitmq.consumer.count",
				metricType: "gauge",
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Consumer Count", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "unacked",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-unacked",
				name: "Unacked",
				metricName: "rabbitmq.message.unacknowledged",
				metricType: "gauge",
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Unacknowledged Messages", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 8, w: 12, h: 4 },
		},
	]
}

export const rabbitmqTemplate: TemplateDefinition = {
	id: templateId("rabbitmq-overview"),
	name: "RabbitMQ Overview",
	description: "Queue depth, publish/deliver rates, consumers, and unacknowledged messages.",
	category: "messaging",
	tags: ["rabbitmq", "messaging"],
	requirements: ["OpenTelemetry rabbitmqreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific RabbitMQ broker.",
			required: false,
			placeholder: "rabbit-prod",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — RabbitMQ` : "RabbitMQ Overview",
			description: "RabbitMQ health — queue depth, throughput, consumers, and unacked messages.",
			tags: ["rabbitmq"],
			widgets: widgets(serviceName),
		})
	},
}
