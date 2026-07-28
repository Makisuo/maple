import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsTimeseries,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// Queue identity lives on the RESOURCE for the rabbitmqreceiver (`rabbitmq.queue.name`), not on
// the datapoint — `attr.queue` matched nothing. Its level metrics are non-monotonic Sums, not
// Gauges, and `metricType` picks the warehouse table, so the `gauge` spelling read `metrics_gauge`
// and rendered empty widgets.
function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	const queueGroup = ["resource.rabbitmq.queue.name"]
	return [
		{
			// One metric carries both states on `state` — ready is the backlog waiting for a
			// consumer, unacknowledged is in flight. Split, not summed.
			id: "queue-depth",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-depth",
				name: "Queue Depth",
				metricName: "rabbitmq.message.current",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: combineWhere(where, `attr.state = "ready"`),
				groupBy: queueGroup,
			}),
			display: { title: "Queue Depth (ready)", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
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
			layout: { x: 6, y: 0, w: 6, h: 6 },
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
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			id: "consumers",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-consumers",
				name: "Consumers",
				metricName: "rabbitmq.consumer.count",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Consumer Count", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			// Was `rabbitmq.message.unacknowledged`, which the receiver has never emitted — unacked
			// is the other half of `rabbitmq.message.current`.
			id: "unacked",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-unacked",
				name: "Unacked",
				metricName: "rabbitmq.message.current",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: combineWhere(where, `attr.state = "unacknowledged"`),
				groupBy: queueGroup,
			}),
			display: { title: "Unacknowledged Messages", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 6 },
		},
		{
			id: "dropped",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "rmq-dropped",
				name: "Dropped",
				metricName: "rabbitmq.message.dropped",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: queueGroup,
			}),
			display: { title: "Dropped Messages / sec", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 6, y: 12, w: 6, h: 6 },
		},
	]
}

export const rabbitmqTemplate: TemplateDefinition = {
	id: templateId("rabbitmq-overview"),
	name: "RabbitMQ Overview",
	description: "Queue depth, publish/deliver rates, consumers, unacknowledged and dropped messages.",
	category: "messaging",
	tags: ["rabbitmq", "messaging"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry rabbitmqreceiver",
		collector: "the OpenTelemetry rabbitmqreceiver",
		setupLabel: "the RabbitMQ receiver",
		hint: "Point it at your RabbitMQ nodes and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["rabbitmq."],
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
