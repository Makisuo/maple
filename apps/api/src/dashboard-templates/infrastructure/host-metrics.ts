import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

function hostWhere(hostName?: string): string {
	return hostName ? `host.name = "${hostName}"` : ""
}

function widgets(hostName?: string): WidgetDef[] {
	const where = hostWhere(hostName)
	const groupBy = ["host.name"]
	return [
		{
			id: "cpu",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-cpu",
				name: "CPU Utilization",
				metricName: "system.cpu.utilization",
				metricType: "gauge",
				whereClause: combineWhere(where),
				groupBy: ["attr.state"],
			}),
			display: { title: "CPU by State", ...CHART_DISPLAY_AREA, unit: "percent" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "memory",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-memory",
				name: "Memory",
				metricName: "system.memory.usage",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.state"],
			}),
			display: { title: "Memory by State", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "disk-io",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-disk-io",
				name: "Disk I/O",
				metricName: "system.disk.io",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.direction"],
			}),
			display: { title: "Disk I/O", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "network",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-network",
				name: "Network",
				metricName: "system.network.io",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.direction"],
			}),
			display: { title: "Network I/O", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "load-average",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-load",
				name: "Load Average",
				metricName: "system.cpu.load_average.1m",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Load Average (1m)", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 8, w: 6, h: 4 },
		},
		{
			id: "filesystem",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "host-fs",
				name: "Filesystem",
				metricName: "system.filesystem.utilization",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.mountpoint"],
			}),
			display: { title: "Filesystem Utilization", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 6, y: 8, w: 6, h: 4 },
		},
	]
}

export const hostMetricsTemplate: TemplateDefinition = {
	id: templateId("host-metrics"),
	name: "Host Metrics",
	description: "CPU, memory, disk I/O, network, load average, and filesystem usage per host.",
	category: "infrastructure",
	tags: ["host", "infra"],
	requirements: ["OpenTelemetry hostmetricsreceiver"],
	parameters: [
		{
			key: paramKey("host_name"),
			label: "Host name",
			description: "Optional — scope to a single host.",
			required: false,
			placeholder: "web-01",
		},
	],
	build: (params) => {
		const hostName = paramValue(params, "host_name")
		return buildPortableDashboard({
			name: hostName ? `${hostName} — Host Metrics` : "Host Metrics",
			description: "Host metrics — CPU, memory, disk, network, load, and filesystem.",
			tags: ["host"],
			widgets: widgets(hostName),
		})
	},
}
