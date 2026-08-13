import {
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
} from "@/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@/dashboard-templates/types"

// Built strictly on metrics the kafkametricsreceiver actually emits. The previous version charted
// `kafka.topic.partitions.messages_in`, `kafka.partition.under_replicated` and
// `kafka.request.time.99p` — none of which exist in that receiver (the last two are JMX-gatherer
// names), so those widgets could never render. Broker-side throughput and request latency are
// simply not available from this receiver; under-replication is derived below instead.
//
// `kafka.brokers`, `kafka.consumer_group.members`, `kafka.topic.partitions` and
// `kafka.partition.replicas*` are non-monotonic Sums, not Gauges — `metricType` picks the
// warehouse table, so the `gauge` spelling read `metrics_gauge` and rendered empty.
function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	return [
		{
			// `lag_sum` is already summed over a group's partitions; the per-partition
			// `kafka.consumer_group.lag` grouped only by consumer group silently averaged
			// partitions against each other.
			id: "consumer-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-lag",
				name: "Consumer Lag",
				metricName: "kafka.consumer_group.lag_sum",
				metricType: "gauge",
				aggregation: "max",
				whereClause: where,
				groupBy: ["attr.group"],
			}),
			display: { title: "Consumer Lag by Group", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
		{
			id: "consumer-members",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-members",
				name: "Members",
				metricName: "kafka.consumer_group.members",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
				groupBy: ["attr.group"],
			}),
			display: { title: "Consumer Group Members", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		{
			id: "broker-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-brokers",
				name: "Brokers",
				metricName: "kafka.brokers",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
			}),
			display: { title: "Active Brokers", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			// Under-replication as replicas minus in-sync replicas. Should sit flat at zero;
			// bars make the excursions read as discrete incidents rather than a filled ribbon.
			id: "partition-under-replicated",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource(
				[
					{
						...makeQueryDraft({
							id: "kafka-replicas",
							name: "A",
							dataSource: "metrics",
							aggregation: "sum",
							isMonotonic: false,
							whereClause: where,
							metricName: "kafka.partition.replicas",
							metricType: "sum",
						}),
						hidden: true,
					},
					{
						...makeQueryDraft({
							id: "kafka-replicas-isr",
							name: "B",
							dataSource: "metrics",
							aggregation: "sum",
							isMonotonic: false,
							whereClause: where,
							metricName: "kafka.partition.replicas_in_sync",
							metricType: "sum",
						}),
						hidden: true,
					},
				],
				[
					{
						id: "kafka-under-replicated",
						name: "Under-replicated",
						expression: "A - B",
						legend: "replicas out of sync",
					},
				],
			),
			display: { title: "Replicas Out of Sync", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			id: "topic-partitions",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "kafka-topic-partitions",
				name: "Partitions",
				metricName: "kafka.topic.partitions",
				metricType: "sum",
				aggregation: "max",
				isMonotonic: false,
				whereClause: where,
				groupBy: ["attr.topic"],
			}),
			display: { title: "Partitions by Topic", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 0, y: 12, w: 12, h: 6 },
		},
	]
}

export const kafkaTemplate: TemplateDefinition = {
	id: templateId("kafka-overview"),
	name: "Kafka Overview",
	description:
		"Consumer lag and group membership, broker count, replica sync health, and partitions by topic.",
	category: "messaging",
	tags: ["kafka", "messaging"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry kafkametricsreceiver",
		collector: "the OpenTelemetry kafkametricsreceiver",
		setupLabel: "the Kafka receiver",
		hint: "Point it at your brokers and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["kafka."],
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
			description: "Kafka health — consumer lag, group members, brokers, replica sync, and partitions.",
			tags: ["kafka"],
			widgets: widgets(serviceName),
		})
	},
}
