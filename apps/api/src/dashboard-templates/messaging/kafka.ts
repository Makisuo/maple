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
			id: "messages-in",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-msg-in",
				name: "Messages In",
				metricName: "kafka.topic.partitions.messages_in",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.topic"],
			}),
			display: { title: "Messages In by Topic", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "consumer-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-lag",
				name: "Consumer Lag",
				metricName: "kafka.consumer_group.lag",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.group"],
			}),
			display: { title: "Consumer Lag by Group", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "broker-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-brokers",
				name: "Brokers",
				metricName: "kafka.brokers",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Active Brokers", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "partition-isr",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-isr",
				name: "ISR",
				metricName: "kafka.partition.under_replicated",
				metricType: "gauge",
				whereClause: where,
			}),
			display: { title: "Under-Replicated Partitions", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "request-latency",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-req-latency",
				name: "Request Latency",
				metricName: "kafka.request.time.99p",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.type"],
			}),
			display: { title: "Request Latency P99", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
			layout: { x: 0, y: 8, w: 12, h: 4 },
		},
	]
}

export const kafkaTemplate: TemplateDefinition = {
	id: templateId("kafka-overview"),
	name: "Kafka Overview",
	description: "Messages by topic, consumer lag, brokers, replication, and request latency.",
	category: "messaging",
	tags: ["kafka", "messaging"],
	requirements: ["OpenTelemetry kafkametricsreceiver"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a specific Kafka cluster by service.name.",
			required: false,
			placeholder: "kafka-prod",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — Kafka` : "Kafka Overview",
			description: "Kafka health — throughput, consumer lag, broker count, ISR, and latency.",
			tags: ["kafka"],
			widgets: widgets(serviceName),
		})
	},
}
