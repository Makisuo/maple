import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	metricsBreakdown,
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
			id: "heap-used",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-heap-used",
				name: "Heap Used",
				metricName: "jvm.memory.used",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "JVM Heap Used", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "heap-committed",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-heap-committed",
				name: "Heap Committed",
				metricName: "jvm.memory.committed",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "JVM Heap Committed", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "gc-pause",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-gc-duration",
				name: "GC Pause",
				metricName: "jvm.gc.duration",
				metricType: "histogram",
				aggregation: "p95_duration",
				whereClause: where,
				groupBy,
			}),
			display: { title: "GC Pause Time (P95)", ...CHART_DISPLAY_AREA, unit: "duration_ms" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "thread-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-thread-count",
				name: "Threads",
				metricName: "jvm.thread.count",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: { title: "Threads", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "classes-loaded",
			visualization: "table",
			dataSource: metricsBreakdown({
				id: "jvm-classes-loaded",
				name: "Classes Loaded",
				metricName: "jvm.class.count",
				metricType: "gauge",
				whereClause: where,
				groupBy,
			}),
			display: {
				title: "Classes Loaded by Service",
				columns: [
					{ field: "name", header: "Service" },
					{ field: "value", header: "Classes", align: "right" },
				],
			},
			layout: { x: 0, y: 8, w: 12, h: 4 },
		},
	]
}

export const jvmRuntimeTemplate: TemplateDefinition = {
	id: templateId("jvm-runtime"),
	name: "JVM Runtime",
	description: "Heap usage, GC pause time, and thread counts for JVM-based services.",
	category: "application",
	tags: ["jvm", "runtime"],
	requirements: ["OpenTelemetry JVM instrumentation"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a single service.",
			required: false,
			placeholder: "checkout-api",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — JVM Runtime` : "JVM Runtime",
			description: "JVM runtime metrics — heap, garbage collection, and threads.",
			tags: ["jvm"],
			widgets: widgets(serviceName),
		})
	},
}
