import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "@/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@/dashboard-templates/types"

function widgets(clusterName?: string): WidgetDef[] {
	// Node/namespace/cluster identity lives on ResourceAttributes — the metrics
	// query-builder reaches it via the `resource.` prefix.
	const where = combineWhere(clusterName ? `resource.k8s.cluster.name = "${clusterName}"` : "")
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
				groupBy: ["resource.k8s.node.name"],
			}),
			display: { title: "Node Ready Status", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
		{
			// `k8s.pod.phase`'s VALUE is a phase enum (1 Pending … 5 Unknown), one datapoint per
			// pod. Averaging or stacking those codes across a namespace produces a number that
			// means nothing; counting the datapoints is the pod count, which is what the chart
			// was always trying to say.
			id: "pod-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-pods",
				name: "Pods",
				metricName: "k8s.pod.phase",
				metricType: "gauge",
				aggregation: "count",
				whereClause: where,
				groupBy: ["resource.k8s.namespace.name"],
			}),
			display: { title: "Pods by Namespace", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		{
			// One datapoint per deployment, so the namespace total needs `sum` — the default
			// `avg` gave the mean replica count of a namespace's deployments.
			id: "deployment-available",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-deployments",
				name: "Available Pods",
				metricName: "k8s.deployment.available",
				metricType: "gauge",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["resource.k8s.namespace.name"],
			}),
			display: { title: "Available Deployment Pods", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			// Replaces a stacked `k8s.namespace.phase`, whose value is 1 for active and 0 for
			// terminating — stacking it just counted namespaces. Restarts are the signal an
			// operator actually opens a cluster dashboard for, and they're bursty, so bars.
			id: "container-restarts",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "k8s-restarts",
				name: "Restarts",
				metricName: "k8s.container.restarts",
				metricType: "gauge",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["resource.k8s.namespace.name"],
			}),
			display: { title: "Container Restarts by Namespace", ...CHART_DISPLAY_BAR, unit: "number" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
	]
}

export const kubernetesClusterTemplate: TemplateDefinition = {
	id: templateId("kubernetes-cluster"),
	name: "Kubernetes Cluster",
	description: "Node readiness, pods per namespace, deployment availability, and container restarts.",
	category: "infrastructure",
	tags: ["kubernetes", "k8s"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry k8sclusterreceiver",
		collector: "the OpenTelemetry k8sclusterreceiver",
		setupLabel: "the k8scluster receiver",
		hint: "Run it against your cluster's API server and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["k8s."],
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
