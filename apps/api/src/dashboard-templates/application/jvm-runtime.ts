import {
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsBreakdown,
	metricsTimeseries,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// Every metric here is an OTel semconv JVM metric, and all of them except `jvm.gc.duration` are
// UpDownCounters — non-monotonic Sums, not Gauges. `metricType` picks the warehouse table, so the
// old `gauge` spelling read `metrics_gauge` and rendered empty widgets.
//
// `jvm.memory.used`/`committed` are also reported per memory pool AND per `jvm.memory.type`
// (heap / non_heap). Charting them without the heap filter and with the default `avg` aggregation
// gave the average of every pool of both types — not heap usage. Filter to heap, sum the pools.
const HEAP_ONLY = `attr.jvm.memory.type = "heap"`

function widgets(serviceName?: string): WidgetDef[] {
	const where = serviceWhereClause(serviceName)
	const heapWhere = combineWhere(serviceWhereClause(serviceName), HEAP_ONLY)
	const groupBy = ["service.name"]
	return [
		{
			id: "heap-used",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-heap-used",
				name: "Heap Used",
				metricName: "jvm.memory.used",
				metricType: "sum",
				aggregation: "sum",
				isMonotonic: false,
				whereClause: heapWhere,
				groupBy,
			}),
			display: { title: "JVM Heap Used", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
		{
			id: "heap-committed",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-heap-committed",
				name: "Heap Committed",
				metricName: "jvm.memory.committed",
				metricType: "sum",
				aggregation: "sum",
				isMonotonic: false,
				whereClause: heapWhere,
				groupBy,
			}),
			display: { title: "JVM Heap Committed", ...CHART_DISPLAY_LINE, unit: "bytes" },
			layout: { x: 6, y: 0, w: 6, h: 6 },
		},
		{
			// The query-builder metrics source supports avg/sum/min/max/count/rate/
			// increase only — no percentiles over histogram buckets — so chart the
			// worst pause per bucket (max over the histogram's Max column).
			id: "gc-pause",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-gc-duration",
				name: "GC Pause",
				metricName: "jvm.gc.duration",
				metricType: "histogram",
				aggregation: "max",
				whereClause: where,
				groupBy,
			}),
			display: { title: "GC Pause Time (Max)", ...CHART_DISPLAY_LINE, unit: "duration_s" },
			layout: { x: 0, y: 6, w: 6, h: 6 },
		},
		{
			id: "thread-count",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "jvm-thread-count",
				name: "Threads",
				metricName: "jvm.thread.count",
				metricType: "sum",
				aggregation: "sum",
				isMonotonic: false,
				whereClause: where,
				groupBy,
			}),
			display: { title: "Threads", ...CHART_DISPLAY_LINE, unit: "number" },
			layout: { x: 6, y: 6, w: 6, h: 6 },
		},
		{
			id: "classes-loaded",
			visualization: "table",
			dataSource: metricsBreakdown({
				id: "jvm-classes-loaded",
				name: "Classes Loaded",
				metricName: "jvm.class.count",
				metricType: "sum",
				aggregation: "sum",
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
			layout: { x: 0, y: 12, w: 12, h: 4 },
		},
	]
}

export const jvmRuntimeTemplate: TemplateDefinition = {
	id: templateId("jvm-runtime"),
	name: "JVM Runtime",
	description: "Heap usage, GC pause time, and thread counts for JVM-based services.",
	category: "application",
	tags: ["jvm", "runtime"],
	requirement: {
		kind: "metrics",
		label: "OpenTelemetry JVM instrumentation",
		collector: "the OpenTelemetry Java agent",
		setupLabel: "the Java agent",
		hint: "Attach it to your JVM and every widget fills in on its own.",
	},
	requiredMetricPrefixes: ["jvm."],
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
