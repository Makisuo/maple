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

function widgets(namespace?: string): WidgetDef[] {
	const where = combineWhere(namespace ? `k8s.namespace.name = "${namespace}"` : "")
	const groupBy = ["k8s.pod.name"]
	return [
		{
			id: "pod-cpu",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pod-cpu",
				name: "Pod CPU",
				metricName: "k8s.pod.cpu.utilization",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Pod CPU Utilization", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "pod-memory",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pod-memory",
				name: "Pod Memory",
				metricName: "k8s.pod.memory.usage",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Pod Memory Usage", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "container-restarts",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-restarts",
				name: "Restarts",
				metricName: "k8s.container.restarts",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Container Restarts / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "network-io",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pod-network",
				name: "Network I/O",
				metricName: "k8s.pod.network.io",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy: ["attr.direction"],
			}),
			display: { title: "Pod Network I/O", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
	]
}

export const kubernetesPodTemplate: TemplateDefinition = {
	id: templateId("kubernetes-pod"),
	name: "Kubernetes Pods",
	description: "Per-pod CPU, memory, container restarts, and network I/O.",
	category: "infrastructure",
	tags: ["kubernetes", "k8s", "pods"],
	requirements: ["OpenTelemetry kubeletstatsreceiver"],
	parameters: [
		{
			key: paramKey("namespace"),
			label: "Namespace",
			description: "Optional — scope to a single namespace.",
			required: false,
			placeholder: "default",
		},
	],
	build: (params) => {
		const namespace = paramValue(params, "namespace")
		return buildPortableDashboard({
			name: namespace ? `${namespace} — Pods` : "Kubernetes Pods",
			description: "Per-pod resource usage — CPU, memory, restarts, and network.",
			tags: ["kubernetes", "pods"],
			widgets: widgets(namespace),
		})
	},
}
