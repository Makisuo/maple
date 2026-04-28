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

function widgets(clusterName?: string): WidgetDef[] {
	const where = combineWhere(clusterName ? `k8s.cluster.name = "${clusterName}"` : "")
	return [
		{
			id: "node-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-nodes",
				name: "Nodes",
				metricName: "k8s.node.condition_ready",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["k8s.node.name"],
			}),
			display: { title: "Node Ready Status", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "pod-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pods",
				name: "Pods",
				metricName: "k8s.pod.phase",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.phase"],
			}),
			display: { title: "Pods by Phase", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "deployment-available",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-deployments",
				name: "Deployments Available",
				metricName: "k8s.deployment.available",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["k8s.namespace.name"],
			}),
			display: { title: "Deployment Availability", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "pods-by-namespace",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pods-ns",
				name: "Pods",
				metricName: "k8s.namespace.phase",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["k8s.namespace.name"],
			}),
			display: { title: "Pods by Namespace", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
	]
}

export const kubernetesClusterTemplate: TemplateDefinition = {
	id: templateId("kubernetes-cluster"),
	name: "Kubernetes Cluster",
	description: "Node readiness, pod phase distribution, and deployment availability.",
	category: "infrastructure",
	tags: ["kubernetes", "k8s"],
	requirements: ["OpenTelemetry k8sclusterreceiver"],
	parameters: [
		{
			key: paramKey("cluster_name"),
			label: "Cluster name",
			description: "Optional — scope to a specific cluster.",
			required: false,
			placeholder: "prod-us-east",
		},
	],
	build: (params) => {
		const clusterName = paramValue(params, "cluster_name")
		return buildPortableDashboard({
			name: clusterName ? `${clusterName} — Cluster` : "Kubernetes Cluster",
			description: "Kubernetes cluster — nodes, pods, deployments, and namespaces.",
			tags: ["kubernetes"],
			widgets: widgets(clusterName),
		})
	},
}
