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
	const groupBy = ["service.name"]
	return [
		{
			id: "event-loop-lag",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "node-eventloop-lag",
				name: "Event Loop Lag",
				metricName: "process.runtime.nodejs.eventloop.lag",
				metricType: "histogram",
				aggregation: "p95_duration",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Event Loop Lag (P95)", ...CHART_DISPLAY_AREA, unit: "duration_ms" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "heap-used",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "node-heap-used",
				name: "Heap Used",
				metricName: "process.runtime.nodejs.memory.heap.used",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Heap Used", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "gc-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "node-gc-count",
				name: "GC Count",
				metricName: "process.runtime.nodejs.gc.count",
				metricType: "sum",
				aggregation: "rate",
				isMonotonic: true,
				whereClause: where,
				groupBy,
			}),
			display: { title: "GC Count / sec", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "active-handles",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "node-active-handles",
				name: "Active Handles",
				metricName: "process.runtime.nodejs.handles",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Active Handles", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
	]
}

export const nodejsRuntimeTemplate: TemplateDefinition = {
	id: templateId("nodejs-runtime"),
	name: "Node.js Runtime",
	description: "Event loop lag, heap usage, GC, and active handles for Node.js services.",
	category: "application",
	tags: ["nodejs", "runtime"],
	requirements: ["OpenTelemetry Node.js instrumentation"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a single service.",
			required: false,
			placeholder: "api-gateway",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — Node.js Runtime` : "Node.js Runtime",
			description: "Node.js runtime metrics — event loop, heap, GC, and handles.",
			tags: ["nodejs"],
			widgets: widgets(serviceName),
		})
	},
}
