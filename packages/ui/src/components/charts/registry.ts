import { lazy, type ComponentType, type LazyExoticComponent } from "react"
import type {
	ChartCategory,
	PlotProps,
	QueryBuilderAreaChartProps,
	QueryBuilderBarChartProps,
	QueryBuilderFunnelChartProps,
	QueryBuilderHbarChartProps,
	QueryBuilderHeatmapChartProps,
	QueryBuilderHistogramChartProps,
	QueryBuilderLineChartProps,
	QueryBuilderPieChartProps,
	ServiceChartProps,
	ThroughputAreaChartProps,
} from "./_shared/chart-types"
import {
	latencyTimeSeriesData,
	throughputTimeSeriesData,
	apdexTimeSeriesData,
	errorRateTimeSeriesData,
	pieSampleData,
	histogramSampleData,
	heatmapSampleData,
	funnelSampleData,
	hbarSampleData,
} from "./_shared/sample-data"

/**
 * One registry entry, carrying its chart's EXACT props type.
 *
 * The entry used to be a single interface whose `component` was
 * `ComponentType<BaseChartProps>`, and that erasure is what forced every chart
 * to accept every prop: a heterogeneous list can only be typed uniformly if all
 * its members share one signature. Discriminating on `kind` lets each entry keep
 * its own signature, so the widget factory's `switch` narrows to a component
 * that only accepts the settings its chart can actually honour.
 *
 * `component` stays assignable to `ComponentType<PlotProps>` for callers that
 * only ever pass `data` — the gallery thumbnails and the chart picker — because
 * props are contravariant and every extra field is optional. Those callers need
 * no switch; see `previewComponent` below.
 */
interface ChartEntry<TKind extends string, TProps extends PlotProps> {
	kind: TKind
	id: string
	name: string
	description: string
	category: ChartCategory
	component: LazyExoticComponent<ComponentType<TProps>>
	sampleData: Record<string, unknown>[]
	tags: string[]
}

export type ChartRegistryEntry =
	| ChartEntry<"line", QueryBuilderLineChartProps>
	| ChartEntry<"area", QueryBuilderAreaChartProps>
	| ChartEntry<"bar", QueryBuilderBarChartProps>
	| ChartEntry<"pie", QueryBuilderPieChartProps>
	| ChartEntry<"histogram", QueryBuilderHistogramChartProps>
	| ChartEntry<"heatmap", QueryBuilderHeatmapChartProps>
	| ChartEntry<"funnel", QueryBuilderFunnelChartProps>
	| ChartEntry<"hbar", QueryBuilderHbarChartProps>
	| ChartEntry<"service", ServiceChartProps>
	| ChartEntry<"throughput", ThroughputAreaChartProps>

export type ChartKind = ChartRegistryEntry["kind"]

export const chartRegistry: ChartRegistryEntry[] = [
	// Query Builder Bar
	{
		kind: "bar",
		id: "query-builder-bar",
		name: "Bar",
		description: "Bar chart driven by the query builder",
		category: "bar",
		component: lazy(() =>
			import("./bar/query-builder-bar-chart").then((m) => ({
				default: m.QueryBuilderBarChart,
			})),
		),
		sampleData: latencyTimeSeriesData,
		tags: ["bar", "query-builder", "dynamic", "multi-query"],
	},

	// Horizontal (ranked) Bars
	{
		kind: "hbar",
		id: "query-builder-hbar",
		name: "Horizontal Bar",
		description: "Ranked categories as horizontal bars, each a share of the total",
		category: "hbar",
		component: lazy(() =>
			import("./hbar/query-builder-hbar-chart").then((m) => ({
				default: m.QueryBuilderHbarChart,
			})),
		),
		sampleData: hbarSampleData,
		tags: ["hbar", "horizontal", "bar", "ranked", "top", "breakdown", "query-builder"],
	},

	// Query Builder Area
	{
		kind: "area",
		id: "query-builder-area",
		name: "Area",
		description: "Area chart driven by the query builder",
		category: "area",
		component: lazy(() =>
			import("./area/query-builder-area-chart").then((m) => ({
				default: m.QueryBuilderAreaChart,
			})),
		),
		sampleData: latencyTimeSeriesData,
		tags: ["area", "query-builder", "dynamic", "multi-query"],
	},

	// Line Charts
	{
		kind: "line",
		id: "query-builder-line",
		name: "Line",
		description: "Line chart driven by the query builder",
		category: "line",
		component: lazy(() =>
			import("./line/query-builder-line-chart").then((m) => ({
				default: m.QueryBuilderLineChart,
			})),
		),
		sampleData: latencyTimeSeriesData,
		tags: ["line", "query-builder", "dynamic", "multi-query"],
	},

	// Service Charts
	{
		kind: "service",
		id: "latency-line",
		name: "Latency Line",
		description: "P99/P95/P50 latency percentiles over time",
		category: "line",
		component: lazy(() =>
			import("./line/latency-line-chart").then((m) => ({ default: m.LatencyLineChart })),
		),
		sampleData: latencyTimeSeriesData,
		tags: ["line", "latency", "percentile", "service"],
	},
	{
		kind: "throughput",
		id: "throughput-area",
		name: "Throughput Area",
		description: "Request throughput over time",
		category: "area",
		component: lazy(() =>
			import("./area/throughput-area-chart").then((m) => ({ default: m.ThroughputAreaChart })),
		),
		sampleData: throughputTimeSeriesData,
		tags: ["area", "throughput", "service"],
	},
	{
		kind: "service",
		id: "apdex-area",
		name: "Apdex Area",
		description: "Apdex score over time (0-1)",
		category: "area",
		component: lazy(() => import("./area/apdex-area-chart").then((m) => ({ default: m.ApdexAreaChart }))),
		sampleData: apdexTimeSeriesData,
		tags: ["area", "apdex", "service"],
	},
	{
		kind: "service",
		id: "error-rate-area",
		name: "Error Rate Area",
		description: "Error rate percentage over time",
		category: "area",
		component: lazy(() =>
			import("./area/error-rate-area-chart").then((m) => ({ default: m.ErrorRateAreaChart })),
		),
		sampleData: errorRateTimeSeriesData,
		tags: ["area", "error", "rate", "service"],
	},

	// Pie Charts
	{
		kind: "pie",
		id: "query-builder-pie",
		name: "Pie",
		description: "Categorical distribution as a pie or donut",
		category: "pie",
		component: lazy(() =>
			import("./pie/query-builder-pie-chart").then((m) => ({
				default: m.QueryBuilderPieChart,
			})),
		),
		sampleData: pieSampleData,
		tags: ["pie", "donut", "breakdown", "query-builder"],
	},

	// Histograms
	{
		kind: "histogram",
		id: "query-builder-histogram",
		name: "Histogram",
		description: "Distribution of values across buckets",
		category: "histogram",
		component: lazy(() =>
			import("./histogram/query-builder-histogram-chart").then((m) => ({
				default: m.QueryBuilderHistogramChart,
			})),
		),
		sampleData: histogramSampleData,
		tags: ["histogram", "distribution", "buckets", "query-builder"],
	},

	// Heatmaps
	{
		kind: "heatmap",
		id: "query-builder-heatmap",
		name: "Heatmap",
		description: "2D density visualization across two dimensions",
		category: "heatmap",
		component: lazy(() =>
			import("./heatmap/query-builder-heatmap-chart").then((m) => ({
				default: m.QueryBuilderHeatmapChart,
			})),
		),
		sampleData: heatmapSampleData,
		tags: ["heatmap", "density", "2d", "query-builder"],
	},

	// Funnels
	{
		kind: "funnel",
		id: "query-builder-funnel",
		name: "Funnel",
		description: "Stage-by-stage conversion as descending bars",
		category: "funnel",
		component: lazy(() =>
			import("./funnel/query-builder-funnel-chart").then((m) => ({
				default: m.QueryBuilderFunnelChart,
			})),
		),
		sampleData: funnelSampleData,
		tags: ["funnel", "conversion", "stages", "query-builder"],
	},
]

/**
 * Ids that were REMOVED, and what they resolve to now.
 *
 * `default-bar`, `gradient-area` and `dotted-line` were Recharts demos that
 * existed only as the chart picker's thumbnails — the widget a card actually
 * created was always the `query-builder-*` entry beside it. They were also
 * reachable as persisted `display.chartId` values, because the old "Chart Style"
 * dropdown wrote them and `v1-to-v2` preserves whatever `chartId` a widget
 * already has.
 *
 * So deleting the entries outright would blank every dashboard tile still
 * carrying one, and would send `toPanelType` down its `"line"` fallback for what
 * is really an area widget. Redirecting is what makes the deletion invisible:
 * the style is gone, the widget it described is not.
 */
const REMOVED_CHART_IDS: Readonly<Record<string, string>> = {
	"default-bar": "query-builder-bar",
	"gradient-area": "query-builder-area",
	"dotted-line": "query-builder-line",
}

export function getChartById(id: string): ChartRegistryEntry | undefined {
	const resolved = REMOVED_CHART_IDS[id] ?? id
	return chartRegistry.find((c) => c.id === resolved)
}

// `getChartsByCategory` and `searchCharts` lived here with no callers in any app
// or package. `entry.category` is still load-bearing — `makeChartWidget` picks a
// skeleton from it and `panel-types.ts` maps chartId to panel type through it —
// but `entry.tags` is now read by nothing. Kept as data rather than deleted from
// 15 entries: it is the input a real chart search would want, and it costs a
// string array. Delete it too if a search never materialises.
