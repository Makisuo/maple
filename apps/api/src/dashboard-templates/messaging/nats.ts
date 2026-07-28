import {
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	metricsTimeseries,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// The NATS Prometheus exporter namespaces every /varz field as `gnatsd_varz_<field>` (the
// `gnatsd` prefix is kept for backward compatibility, see its collector.go) — the old `nats.*`
// names in this template were never emitted by anything, so no widget could render.
//
// It also registers ALL varz fields as Prometheus gauges, so prometheusreceiver lands every one
// of them in `metrics_gauge`. That rules out `rate`/`increase`, which the query engine only
// computes over `metrics_sum` — so the cumulative counters (in_msgs/out_msgs) can't be charted
// as a per-second rate here, and this dashboard sticks to the fields that read as levels.
function gaugeChart(opts: {
	id: string
	name: string
	metricName: string
	title: string
	unit: string
	where: string
	aggregation?: string
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
		}),
		display: { title: opts.title, ...CHART_DISPLAY_LINE, unit: opts.unit },
		layout: opts.layout,
	}
}

function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	return [
		gaugeChart({
			id: "connections",
			name: "Connections",
			metricName: "gnatsd_varz_connections",
			title: "Active Connections",
			unit: "number",
			where,
			layout: { x: 0, y: 0, w: 6, h: 6 },
		}),
		gaugeChart({
			id: "subscriptions",
			name: "Subscriptions",
			metricName: "gnatsd_varz_subscriptions",
			title: "Subscriptions",
			unit: "number",
			where,
			layout: { x: 6, y: 0, w: 6, h: 6 },
		}),
		gaugeChart({
			id: "slow-consumers",
			name: "Slow Consumers",
			metricName: "gnatsd_varz_slow_consumers",
			title: "Slow Consumers (cumulative)",
			unit: "number",
			where,
			layout: { x: 0, y: 6, w: 6, h: 6 },
		}),
		gaugeChart({
			id: "routes",
			name: "Routes",
			metricName: "gnatsd_varz_routes",
			title: "Cluster Routes",
			unit: "number",
			where,
			layout: { x: 6, y: 6, w: 6, h: 6 },
		}),
		gaugeChart({
			id: "mem",
			name: "Memory",
			metricName: "gnatsd_varz_mem",
			title: "Server Memory",
			unit: "bytes",
			where,
			layout: { x: 0, y: 12, w: 6, h: 6 },
		}),
		// varz reports CPU as a 0–100 percentage, so `percent_100` — the plain `percent` unit is a
		// 0–1 ratio that multiplies by 100 at display.
		gaugeChart({
			id: "cpu",
			name: "CPU",
			metricName: "gnatsd_varz_cpu",
			title: "Server CPU",
			unit: "percent_100",
			where,
			layout: { x: 6, y: 12, w: 6, h: 6 },
		}),
	]
}

export const natsTemplate: TemplateDefinition = {
	id: templateId("nats-overview"),
	name: "NATS Overview",
	description: "Connections, subscriptions, slow consumers, cluster routes, and server CPU/memory.",
	category: "messaging",
	tags: ["nats", "messaging"],
	requirement: {
		kind: "metrics",
		label: "NATS Prometheus exporter via prometheusreceiver",
		collector: "the NATS Prometheus exporter, scraped by prometheusreceiver",
		setupLabel: "the NATS exporter",
		hint: "Scrape its /varz endpoint with prometheusreceiver and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["gnatsd_varz_"],
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
			description: "NATS server health — connections, subscriptions, routes, and resource use.",
			tags: ["nats"],
			widgets: widgets(serviceName),
		})
	},
}
