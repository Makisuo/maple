import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "@/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@/dashboard-templates/types"

function widgets(host?: string): WidgetDef[] {
	// Container/host identity lives on ResourceAttributes — the metrics
	// query-builder reaches it via the `resource.` prefix. kubeletstats
	// per-container rows also carry container.* names (on a 0..1 scale); the
	// pod-name guard keeps them out, same as the containers page queries.
	const where = combineWhere('resource.k8s.pod.name = ""', host ? `resource.host.name = "${host}"` : "")
	const groupBy = ["resource.container.name"]
	return [
		{
			id: "container-cpu",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "docker-container-cpu",
				name: "Container CPU",
				metricName: "container.cpu.utilization",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Container CPU (%)", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
		{
			id: "container-memory",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "docker-container-memory",
				name: "Container Memory",
				metricName: "container.memory.usage.total",
				metricType: "sum",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Container Memory Usage", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		// Docker splits direction into two metric names (rx/tx), unlike k8s's
		// `attr.direction` — hence two widgets.
		{
			id: "container-net-rx",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "docker-container-net-rx",
				name: "Network In",
				metricName: "container.network.io.usage.rx_bytes",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Network In", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			id: "container-net-tx",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "docker-container-net-tx",
				name: "Network Out",
				metricName: "container.network.io.usage.tx_bytes",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Network Out", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			id: "container-blockio",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "docker-container-blockio",
				name: "Block I/O",
				metricName: "container.blockio.io_service_bytes_recursive",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.operation"],
			}),
			display: { title: "Block I/O by Operation", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 0, y: 12, w: 12, h: 6 },
		},
	]
}

export const dockerContainersTemplate: TemplateDefinition = {
	id: templateId("docker-containers"),
	name: "Docker Containers",
	description: "Per-container CPU, memory, network, and block I/O from the Docker stats receiver.",
	category: "infrastructure",
	tags: ["docker", "containers"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry dockerstatsreceiver",
		collector: "the OpenTelemetry Docker stats receiver",
		setupLabel: "the Docker stats receiver",
		hint: "Run the Maple Docker agent on each host and every widget fills in on its own.",
	},
	// Deliberately NOT the bare "container." prefix: kubeletstats also emits
	// container.cpu./container.memory. names, which would light this template
	// up as ready on k8s-only orgs. Network + blockio are dockerstats-only.
	requiredMetricPrefixes: ["container.network.io.", "container.blockio."],
	parameters: [
		{
			key: paramKey("host"),
			label: "Host",
			description: "Optional — scope to a single host.",
			required: false,
			placeholder: "docker-host-1",
		},
	],
	build: (params) => {
		const host = paramValue(params, "host")
		return buildPortableDashboard({
			name: host ? `${host} — Containers` : "Docker Containers",
			description: "Per-container resource usage — CPU, memory, network, and block I/O.",
			tags: ["docker", "containers"],
			widgets: widgets(host),
		})
	},
}
