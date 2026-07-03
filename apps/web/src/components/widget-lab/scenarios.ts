import type { WidgetDataState, WidgetDisplayConfig } from "@/components/dashboard-builder/types"
import { chartRegistry } from "@maple/ui/components/charts/registry"

export interface WidgetScenario {
	label: string
	dataState: WidgetDataState
	display: WidgetDisplayConfig
}

export interface ChartScenario extends WidgetScenario {
	chartId: string
	chartName: string
	category: string
}

const loadingState: WidgetDataState = { status: "loading" }

const emptyState: WidgetDataState = {
	status: "error",
	message: "No query data found in selected time range",
}

const runtimeErrorState: WidgetDataState = {
	status: "error",
	title: "Unable to load",
	message: "ClickHouse: query timed out after 30s",
	kind: "runtime",
}

const decodeErrorState: WidgetDataState = {
	status: "error",
	title: "Schema mismatch",
	message: "Expected field 'errorRate' but got 'error_rate' from the query result.",
	kind: "decode",
}

const ready = <T>(data: T): WidgetDataState => ({ status: "ready", data })

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

export const statScenarios: WidgetScenario[] = [
	{
		label: "Plain number",
		dataState: ready(2847),
		display: { title: "Active spans", unit: "number" },
	},
	{
		label: "Large number",
		dataState: ready(1_245_891),
		display: { title: "Total traces", unit: "number" },
	},
	{
		label: "Percent",
		dataState: ready(3.42),
		display: { title: "Error rate", unit: "percent" },
	},
	{
		label: "Duration (ms)",
		dataState: ready(184.7),
		display: { title: "p99 latency", unit: "duration_ms" },
	},
	{
		label: "Bytes",
		dataState: ready(4_823_191_232),
		display: { title: "Ingest volume", unit: "bytes" },
	},
	{
		label: "Threshold — green",
		dataState: ready(0.4),
		display: {
			title: "Error rate",
			unit: "percent",
			thresholds: [
				{ value: 0, color: "var(--color-emerald-500)" },
				{ value: 1, color: "var(--color-amber-500)" },
				{ value: 5, color: "var(--color-red-500)" },
			],
		},
	},
	{
		label: "Threshold — amber",
		dataState: ready(2.6),
		display: {
			title: "Error rate",
			unit: "percent",
			thresholds: [
				{ value: 0, color: "var(--color-emerald-500)" },
				{ value: 1, color: "var(--color-amber-500)" },
				{ value: 5, color: "var(--color-red-500)" },
			],
		},
	},
	{
		label: "Threshold — red",
		dataState: ready(8.1),
		display: {
			title: "Error rate",
			unit: "percent",
			thresholds: [
				{ value: 0, color: "var(--color-emerald-500)" },
				{ value: 1, color: "var(--color-amber-500)" },
				{ value: 5, color: "var(--color-red-500)" },
			],
		},
	},
	{
		label: "Prefix + suffix",
		dataState: ready(1247),
		display: { title: "Saved this month", prefix: "$", suffix: " USD", unit: "number" },
	},
	{
		label: "Zero",
		dataState: ready(0),
		display: { title: "Open incidents", unit: "number" },
	},
	{
		label: "Negative",
		dataState: ready(-12.5),
		display: { title: "Δ vs previous", unit: "percent" },
	},
	{
		label: "Long title",
		dataState: ready(12),
		display: {
			title: "A really really long widget title that should definitely truncate gracefully without overflow",
			unit: "number",
		},
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Active spans", unit: "number" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Active spans", unit: "number" },
	},
	{
		label: "Error — runtime",
		dataState: runtimeErrorState,
		display: { title: "Active spans", unit: "number" },
	},
	{
		label: "Error — decode (Fix with AI)",
		dataState: decodeErrorState,
		display: { title: "Active spans", unit: "number" },
	},
]

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

// Percent unit treats values as 0-1 ratios (0.42 → "42%").
const gaugeThresholds = [
	{ value: 0, color: "var(--color-emerald-500)" },
	{ value: 0.7, color: "var(--color-amber-500)" },
	{ value: 0.9, color: "var(--color-red-500)" },
]

export const gaugeScenarios: WidgetScenario[] = [
	{
		label: "Healthy",
		dataState: ready(0.42),
		display: {
			title: "CPU utilization",
			unit: "percent",
			gauge: { min: 0, max: 1 },
			thresholds: gaugeThresholds,
		},
	},
	{
		label: "Warning",
		dataState: ready(0.78),
		display: {
			title: "CPU utilization",
			unit: "percent",
			gauge: { min: 0, max: 1 },
			thresholds: gaugeThresholds,
		},
	},
	{
		label: "Critical",
		dataState: ready(0.96),
		display: {
			title: "CPU utilization",
			unit: "percent",
			gauge: { min: 0, max: 1 },
			thresholds: gaugeThresholds,
		},
	},
	{
		label: "No thresholds",
		dataState: ready(1240),
		display: { title: "Requests / sec", unit: "number", gauge: { min: 0, max: 2000 } },
	},
	{
		label: "Custom range + duration unit",
		dataState: ready(420),
		display: {
			title: "p99 latency",
			unit: "duration_ms",
			gauge: { min: 0, max: 1000 },
			thresholds: [
				{ value: 0, color: "var(--color-emerald-500)" },
				{ value: 500, color: "var(--color-red-500)" },
			],
		},
	},
	{
		label: "At max",
		dataState: ready(1),
		display: {
			title: "Disk usage",
			unit: "percent",
			gauge: { min: 0, max: 1 },
			thresholds: gaugeThresholds,
		},
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Error rate", unit: "percent", gauge: { min: 0, max: 10 } },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Error rate", gauge: { min: 0, max: 10 } },
	},
]

// ---------------------------------------------------------------------------
// Stat sparkline — preview the StatSparkline component directly with various
// timeseries shapes (the full stat-widget sparkline needs a live data source).
// ---------------------------------------------------------------------------

const makeSeries = (values: number[]): Record<string, unknown>[] =>
	values.map((value, index) => ({
		bucket: `2026-05-13T${String(index).padStart(2, "0")}:00:00Z`,
		value,
	}))

export interface SparklineSample {
	label: string
	data: Record<string, unknown>[]
	color?: string
}

export const sparklineSamples: SparklineSample[] = [
	{ label: "Upward trend", data: makeSeries([12, 18, 15, 24, 31, 29, 38, 44]) },
	{ label: "Downward trend", data: makeSeries([88, 81, 84, 70, 62, 55, 41, 33]) },
	{ label: "Flat", data: makeSeries([50, 51, 49, 50, 50, 51, 49, 50]) },
	{
		label: "Volatile",
		data: makeSeries([20, 64, 18, 72, 30, 88, 12, 56]),
		color: "var(--color-amber-500)",
	},
	{
		label: "Spike (threshold red)",
		data: makeSeries([8, 10, 9, 12, 11, 76, 14, 10]),
		color: "var(--color-red-500)",
	},
	{ label: "Single point (renders nothing)", data: makeSeries([42]) },
]

// ---------------------------------------------------------------------------
// Stat + sparkline — the stat widget with its trend sparkline enabled. In a
// real dashboard the sparkline pulls a live timeseries derived from the stat's
// own query; here we pass static series data so the composed layout (value +
// trend) can be polished without a data source.
// ---------------------------------------------------------------------------

export interface StatSparklineScenario {
	label: string
	value: number
	display: WidgetDisplayConfig
	sparklineData: Record<string, unknown>[]
	sparklineColor?: string
}

const statSparklineThresholds = [
	{ value: 0, color: "var(--color-emerald-500)" },
	{ value: 1, color: "var(--color-amber-500)" },
	{ value: 5, color: "var(--color-red-500)" },
]

export const statSparklineScenarios: StatSparklineScenario[] = [
	{
		label: "Sparkline — upward",
		value: 44,
		display: { title: "Active spans", unit: "number" },
		sparklineData: makeSeries([12, 18, 15, 24, 31, 29, 38, 44]),
	},
	{
		label: "Sparkline — downward",
		value: 33,
		display: { title: "Throughput", unit: "number" },
		sparklineData: makeSeries([88, 81, 84, 70, 62, 55, 41, 33]),
	},
	{
		label: "Sparkline — duration",
		value: 184.7,
		display: { title: "p99 latency", unit: "duration_ms" },
		sparklineData: makeSeries([120, 142, 138, 165, 151, 178, 169, 185]),
	},
	{
		label: "Sparkline — threshold (red)",
		value: 8.1,
		display: { title: "Error rate", unit: "percent", thresholds: statSparklineThresholds },
		sparklineData: makeSeries([1, 1.2, 0.9, 2, 1.8, 6.4, 7.2, 8.1]),
	},
]

// ---------------------------------------------------------------------------
// Chart — iterate every registry entry with its built-in sampleData
// ---------------------------------------------------------------------------

// Threshold + legend scenarios reuse a registry chart's bundled sample data.
const sampleFor = (chartId: string): Record<string, unknown>[] =>
	chartRegistry.find((entry) => entry.id === chartId)?.sampleData ?? []

const latencyThresholds = [
	{ value: 200, color: "var(--color-amber-500)", label: "Warn" },
	{ value: 400, color: "var(--color-red-500)", label: "SLO breach" },
]

export const chartScenarios: ChartScenario[] = [
	...chartRegistry.map(
		(entry): ChartScenario => ({
			label: entry.name,
			chartId: entry.id,
			chartName: entry.name,
			category: entry.category,
			dataState: ready(entry.sampleData),
			display: {
				title: entry.name,
				chartId: entry.id,
			},
		}),
	),
	{
		label: "Line + thresholds",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(sampleFor("query-builder-line")),
		display: {
			title: "Latency with SLO thresholds",
			chartId: "query-builder-line",
			unit: "duration_ms",
			thresholds: latencyThresholds,
		},
	},
	{
		label: "Area + thresholds",
		chartId: "query-builder-area",
		chartName: "Query Builder Area",
		category: "area",
		dataState: ready(sampleFor("query-builder-area")),
		display: {
			title: "Latency with SLO thresholds",
			chartId: "query-builder-area",
			unit: "duration_ms",
			thresholds: latencyThresholds,
		},
	},
	{
		label: "Bar + thresholds",
		chartId: "query-builder-bar",
		chartName: "Query Builder Bar",
		category: "bar",
		dataState: ready(sampleFor("query-builder-bar")),
		display: {
			title: "Latency with SLO thresholds",
			chartId: "query-builder-bar",
			unit: "duration_ms",
			thresholds: latencyThresholds,
		},
	},
	{
		label: "Legend — right (stats table)",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(sampleFor("query-builder-line")),
		display: {
			title: "Latency percentiles",
			chartId: "query-builder-line",
			unit: "duration_ms",
			chartPresentation: { legend: "right" },
		},
	},
	{
		label: "Loading",
		chartId: "gradient-area",
		chartName: "Gradient Area",
		category: "area",
		dataState: loadingState,
		display: { title: "Gradient Area", chartId: "gradient-area" },
	},
	{
		label: "Empty",
		chartId: "gradient-area",
		chartName: "Gradient Area",
		category: "area",
		dataState: emptyState,
		display: { title: "Gradient Area", chartId: "gradient-area" },
	},
	{
		label: "Error",
		chartId: "gradient-area",
		chartName: "Gradient Area",
		category: "area",
		dataState: runtimeErrorState,
		display: { title: "Gradient Area", chartId: "gradient-area" },
	},
]

// ---------------------------------------------------------------------------
// Stress / edge cases — high cardinality, long names, null/zero data.
// These exercise the palette (distinct colors past series 5), legend overflow,
// and the pie/bar "Other" bucketing.
// ---------------------------------------------------------------------------

/** N synthetic timeseries with smooth, deterministic, distinct shapes. */
function makeManySeries(seriesCount: number, points = 14, namePrefix = "service"): Record<string, unknown>[] {
	const base = new Date("2026-01-01T00:00:00Z").getTime()
	return Array.from({ length: points }, (_, p) => {
		const row: Record<string, unknown> = {
			bucket: new Date(base + p * 3_600_000).toISOString(),
		}
		for (let s = 0; s < seriesCount; s++) {
			const phase = (s * 0.7) % (Math.PI * 2)
			const amp = 20 + (s % 7) * 8
			row[`${namePrefix}-${s + 1}`] = Math.max(
				0,
				Math.round(amp + amp * Math.sin(p / 2 + phase) + (s % 5) * 3),
			)
		}
		return row
	})
}

/** A long-tail (Zipf-ish) categorical distribution for pie stress tests. */
function makePieSlices(count: number, namePrefix = "service"): { name: string; value: number }[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `${namePrefix}-${i + 1}`,
		value: Math.round(120 + 6000 / (i + 1)),
	}))
}

const longNameSeries: Record<string, unknown>[] = makeManySeries(3, 12).map((row, i) => {
	const base = new Date("2026-01-01T00:00:00Z").getTime()
	return {
		bucket: new Date(base + i * 3_600_000).toISOString(),
		"checkout-service @ us-east-1 (primary cluster, canary v2)": row["service-1"],
		"notification-worker @ eu-west-1 (overflow pool, spot instances)": row["service-2"],
		"analytics-ingest @ ap-southeast-2 (batch tier, reserved capacity)": row["service-3"],
	}
})

// Mixed null / NaN / numbers — verifies asFiniteNumber coercion (renders, no crash).
const nullySeries: Record<string, unknown>[] = [
	{ bucket: "2026-01-01T00:00:00Z", a: 12, b: null, c: 5 },
	{ bucket: "2026-01-01T01:00:00Z", a: null, b: 8, c: Number.NaN },
	{ bucket: "2026-01-01T02:00:00Z", a: 18, b: 11, c: 7 },
	{ bucket: "2026-01-01T03:00:00Z", a: 9, b: null, c: 4 },
	{ bucket: "2026-01-01T04:00:00Z", a: 14, b: 6, c: null },
]

// All-zero series — verifies flat-line handling and pie "No data".
const allZeroSeries: Record<string, unknown>[] = [
	{ bucket: "2026-01-01T00:00:00Z", a: 0, b: 0 },
	{ bucket: "2026-01-01T01:00:00Z", a: 0, b: 0 },
	{ bucket: "2026-01-01T02:00:00Z", a: 0, b: 0 },
	{ bucket: "2026-01-01T03:00:00Z", a: 0, b: 0 },
]

// Sparse rate-like series — 24 zero-filled buckets with a handful of isolated
// non-zero points at 0.02-0.08 (the MAP-49 screenshot shape: low-volume demo
// data bucketed at 30m over 12h). Isolated points must render as visible dots,
// not invisible zero-width triangles.
const sparseRateSeries: Record<string, unknown>[] = Array.from({ length: 24 }, (_, i) => {
	const base = new Date("2026-01-01T00:00:00Z").getTime()
	const row: Record<string, unknown> = {
		bucket: new Date(base + i * 1_800_000).toISOString(),
		"demo-api": 0,
		"demo-frontend": 0,
		"demo-worker": 0,
	}
	if (i === 4) row["demo-api"] = 0.05
	if (i === 9) row["demo-frontend"] = 0.04
	if (i === 10) row["demo-frontend"] = 0.07
	if (i === 15) row["demo-worker"] = 0.07
	if (i === 20) row["demo-api"] = 0.02
	if (i === 21) row["demo-frontend"] = 0.045
	return row
})

// Single-point series — one bucket only.
const singlePointSeries: Record<string, unknown>[] = [
	{ bucket: "2026-01-01T00:00:00Z", "demo-api": 42, "demo-worker": 17 },
]

export const stressScenarios: ChartScenario[] = [
	{
		label: "Line — 25 series (compact legend)",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(makeManySeries(25)),
		display: {
			title: "Latency by service (25)",
			chartId: "query-builder-line",
			unit: "duration_ms",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Line — 50 series (stats legend)",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(makeManySeries(50)),
		display: {
			title: "Latency by service (50)",
			chartId: "query-builder-line",
			unit: "duration_ms",
			chartPresentation: { legend: "visible", seriesStats: true },
		},
	},
	{
		label: "Area — 25 series (stacked)",
		chartId: "query-builder-area",
		chartName: "Query Builder Area",
		category: "area",
		dataState: ready(makeManySeries(25)),
		display: {
			title: "Throughput by service (25)",
			chartId: "query-builder-area",
			stacked: true,
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Bar — 25 series → Other (stacked)",
		chartId: "query-builder-bar",
		chartName: "Query Builder Bar",
		category: "bar",
		dataState: ready(makeManySeries(25)),
		display: {
			title: "Requests by service (25 → Other)",
			chartId: "query-builder-bar",
			stacked: true,
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Bar — 50 series → Other (right legend)",
		chartId: "query-builder-bar",
		chartName: "Query Builder Bar",
		category: "bar",
		dataState: ready(makeManySeries(50)),
		display: {
			title: "Requests by service (50 → Other)",
			chartId: "query-builder-bar",
			stacked: true,
			chartPresentation: { legend: "right", seriesStats: false },
		},
	},
	{
		// Line keeps every series (no "Other" bucketing), so the right legend is
		// genuinely tall — confirms it scrolls within the card instead of overflowing.
		label: "Line — 50 series (right legend, scrolls)",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(makeManySeries(50)),
		display: {
			title: "Latency by service (50, right legend)",
			chartId: "query-builder-line",
			unit: "duration_ms",
			chartPresentation: { legend: "right", seriesStats: true },
		},
	},
	{
		label: "Pie — 20 slices → Other",
		chartId: "query-builder-pie",
		chartName: "Query Builder Pie",
		category: "pie",
		dataState: ready(makePieSlices(20)),
		display: { title: "Traffic by service (20 → Other)", chartId: "query-builder-pie", pie: {} },
	},
	{
		label: "Pie — 50 slices → Other",
		chartId: "query-builder-pie",
		chartName: "Query Builder Pie",
		category: "pie",
		dataState: ready(makePieSlices(50)),
		display: {
			title: "Traffic by service (50 → Other)",
			chartId: "query-builder-pie",
			pie: {},
		},
	},
	{
		label: "Line — long series names",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(longNameSeries),
		display: {
			title: "Latency (long names)",
			chartId: "query-builder-line",
			unit: "duration_ms",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Line — null / NaN values",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(nullySeries),
		display: {
			title: "Sparse series (null/NaN)",
			chartId: "query-builder-line",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Area — all-zero series",
		chartId: "query-builder-area",
		chartName: "Query Builder Area",
		category: "area",
		dataState: ready(allZeroSeries),
		display: {
			title: "Flat at zero",
			chartId: "query-builder-area",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Pie — all-zero (No data)",
		chartId: "query-builder-pie",
		chartName: "Query Builder Pie",
		category: "pie",
		dataState: ready([
			{ name: "a", value: 0 },
			{ name: "b", value: 0 },
		]),
		display: { title: "Empty distribution", chartId: "query-builder-pie", pie: {} },
	},
	{
		label: "Area — sparse rate (isolated points)",
		chartId: "query-builder-area",
		chartName: "Query Builder Area",
		category: "area",
		dataState: ready(sparseRateSeries),
		display: {
			title: "Error rate by service (sparse)",
			chartId: "query-builder-area",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Bar — sparse rate (isolated points)",
		chartId: "query-builder-bar",
		chartName: "Query Builder Bar",
		category: "bar",
		dataState: ready(sparseRateSeries),
		display: {
			title: "Error rate by service (sparse)",
			chartId: "query-builder-bar",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Line — sparse rate (isolated points)",
		chartId: "query-builder-line",
		chartName: "Query Builder Line",
		category: "line",
		dataState: ready(sparseRateSeries),
		display: {
			title: "Error rate by service (sparse)",
			chartId: "query-builder-line",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Area — single point",
		chartId: "query-builder-area",
		chartName: "Query Builder Area",
		category: "area",
		dataState: ready(singlePointSeries),
		display: {
			title: "Single bucket",
			chartId: "query-builder-area",
			chartPresentation: { legend: "visible", seriesStats: false },
		},
	},
	{
		label: "Bar — all-zero series",
		chartId: "query-builder-bar",
		chartName: "Query Builder Bar",
		category: "bar",
		dataState: ready(allZeroSeries),
		display: {
			title: "Flat at zero (bar)",
			chartId: "query-builder-bar",
			chartPresentation: { legend: "visible", seriesStats: true },
		},
	},
]

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const serviceRows = [
	{ service: "api-gateway", p99: 245, throughput: 1820, errorRate: 0.4 },
	{ service: "user-service", p99: 132, throughput: 980, errorRate: 1.2 },
	{ service: "order-service", p99: 318, throughput: 642, errorRate: 4.8 },
	{ service: "auth-service", p99: 89, throughput: 2104, errorRate: 0.1 },
	{ service: "billing-service", p99: 412, throughput: 240, errorRate: 6.3 },
	{ service: "notification-service", p99: 76, throughput: 1502, errorRate: 0.7 },
]

const wideRows = Array.from({ length: 6 }).map((_, i) => ({
	service: `svc-${i + 1}`,
	region: ["us-east-1", "us-west-2", "eu-west-1", "ap-south-1"][i % 4],
	version: `v1.${i}.${i + 2}`,
	requests: 1000 + i * 240,
	errors: i * 7,
	p50: 12 + i * 4,
	p90: 84 + i * 11,
	p95: 110 + i * 14,
	p99: 220 + i * 32,
	cpu: 12 + i * 6,
	memory: 240 + i * 30,
}))

export const tableScenarios: WidgetScenario[] = [
	{
		label: "Typical (5 cols)",
		dataState: ready(serviceRows),
		display: {
			title: "Service overview",
			columns: [
				{ field: "service", header: "Service" },
				{ field: "p99", header: "p99", unit: "duration_ms", align: "right" },
				{ field: "throughput", header: "req/s", unit: "requests_per_sec", align: "right" },
				{ field: "errorRate", header: "Error rate", unit: "percent", align: "right" },
			],
		},
	},
	{
		label: "With cell thresholds",
		dataState: ready(serviceRows),
		display: {
			title: "Service health",
			columns: [
				{ field: "service", header: "Service" },
				{
					field: "errorRate",
					header: "Error rate",
					unit: "percent",
					align: "right",
					thresholds: [
						{ value: 0, color: "var(--color-emerald-500)" },
						{ value: 1, color: "var(--color-amber-500)" },
						{ value: 5, color: "var(--color-red-500)" },
					],
				},
				{
					field: "p99",
					header: "p99",
					unit: "duration_ms",
					align: "right",
					thresholds: [
						{ value: 0, color: "var(--color-emerald-500)" },
						{ value: 200, color: "var(--color-amber-500)" },
						{ value: 400, color: "var(--color-red-500)" },
					],
				},
			],
		},
	},
	{
		label: "Wide (10+ cols)",
		dataState: ready(wideRows),
		display: {
			title: "All metrics",
			columns: [
				{ field: "service", header: "Service" },
				{ field: "region", header: "Region" },
				{ field: "version", header: "Version" },
				{ field: "requests", header: "Reqs", unit: "number", align: "right" },
				{ field: "errors", header: "Errs", unit: "number", align: "right" },
				{ field: "p50", header: "p50", unit: "duration_ms", align: "right" },
				{ field: "p90", header: "p90", unit: "duration_ms", align: "right" },
				{ field: "p95", header: "p95", unit: "duration_ms", align: "right" },
				{ field: "p99", header: "p99", unit: "duration_ms", align: "right" },
				{ field: "cpu", header: "CPU %", unit: "percent", align: "right" },
				{ field: "memory", header: "Mem (MB)", unit: "number", align: "right" },
			],
		},
	},
	{
		label: "Auto-detect columns",
		dataState: ready(serviceRows),
		display: { title: "Auto columns" },
	},
	{
		label: "Long string values",
		dataState: ready([
			{
				name: "billing-service @ us-east-1 with a very long descriptor",
				detail: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
			},
			{
				name: "auth-service",
				detail: "Short value here.",
			},
		]),
		display: { title: "Truncation QA" },
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: {
			title: "Service overview",
			columns: [
				{ field: "service", header: "Service" },
				{ field: "p99", header: "p99", unit: "duration_ms" },
			],
		},
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Service overview" },
	},
	{
		label: "Error — decode",
		dataState: decodeErrorState,
		display: { title: "Service overview" },
	},
]

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const traceRows = [
	{
		traceId: "8c1a4f2b7e9d3c5a6b8d9e0f1a2b3c4d",
		timestamp: "2026-05-13T12:04:11Z",
		spanName: "GET /api/v1/orders",
		serviceName: "api-gateway",
		durationMs: 124,
		statusCode: "Ok",
	},
	{
		traceId: "9d2b5e3c8f0a4d6b7c9e1f2a3b4c5d6e",
		timestamp: "2026-05-13T12:03:58Z",
		spanName: "POST /api/v1/payments",
		serviceName: "billing-service",
		durationMs: 612,
		statusCode: "Error",
	},
	{
		traceId: "1e3c6d4a9b1b5e7c8d0f1a2b3c4d5e6f",
		timestamp: "2026-05-13T12:03:42Z",
		spanName: "GET /api/v1/users/me",
		serviceName: "user-service",
		durationMs: 38,
		statusCode: "Ok",
	},
	{
		traceId: "2f4d7e5b0c2c6f8d9e1a2b3c4d5e6f70",
		timestamp: "2026-05-13T12:03:30Z",
		spanName: "consume order.created",
		serviceName: "notification-service",
		durationMs: 4,
		statusCode: "Ok",
	},
	{
		traceId: "3a5e8f6c1d3d7a9e0f1b2c3d4e5f6071",
		timestamp: "2026-05-13T12:02:55Z",
		spanName: "POST /oauth/token",
		serviceName: "auth-service",
		durationMs: 892,
		statusCode: "Error",
	},
]

const logRows = [
	{
		timestamp: "2026-05-13T12:04:18Z",
		severityText: "ERROR",
		serviceName: "billing-service",
		body: "Failed to charge card: gateway returned 502 after 3 retries",
		logAttributes: { customerId: "cus_482", attempt: 3 },
	},
	{
		timestamp: "2026-05-13T12:04:11Z",
		severityText: "WARN",
		serviceName: "api-gateway",
		body: "Rate limit threshold reached for client",
		logAttributes: { clientId: "client_19" },
	},
	{
		timestamp: "2026-05-13T12:04:02Z",
		severityText: "INFO",
		serviceName: "user-service",
		body: "User registered successfully",
		logAttributes: { userId: "u_2147" },
	},
	{
		timestamp: "2026-05-13T12:03:51Z",
		severityText: "DEBUG",
		serviceName: "order-service",
		body: "Cache hit for key orders:user:2147",
		logAttributes: { hit: true },
	},
	{
		timestamp: "2026-05-13T12:03:44Z",
		severityText: "FATAL",
		serviceName: "auth-service",
		body: "Database connection pool exhausted",
		logAttributes: {},
	},
]

export const listScenarios: WidgetScenario[] = [
	{
		label: "Recent traces",
		dataState: ready(traceRows),
		display: {
			title: "Recent traces",
			listDataSource: "traces",
			columns: [
				{ field: "traceId", header: "Trace" },
				{ field: "spanName", header: "Operation" },
				{ field: "serviceName", header: "Service" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "statusCode", header: "Status" },
			],
		},
	},
	{
		label: "Recent logs",
		dataState: ready(logRows),
		display: {
			title: "Recent logs",
			listDataSource: "logs",
			columns: [
				{ field: "timestamp", header: "Time" },
				{ field: "severityText", header: "Level" },
				{ field: "serviceName", header: "Service" },
				{ field: "body", header: "Message" },
			],
		},
	},
	{
		label: "Auto columns",
		dataState: ready(traceRows.slice(0, 3)),
		display: { title: "Auto columns (traces)" },
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Recent traces", listDataSource: "traces" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Recent traces", listDataSource: "traces" },
	},
]

// ---------------------------------------------------------------------------
// Pie
// ---------------------------------------------------------------------------

const pieFew = [
	{ name: "api-gateway", value: 4820 },
	{ name: "user-service", value: 3210 },
	{ name: "order-service", value: 1740 },
]

const pieMany = [
	{ name: "api-gateway", value: 4820 },
	{ name: "user-service", value: 3210 },
	{ name: "order-service", value: 1740 },
	{ name: "auth-service", value: 920 },
	{ name: "billing-service", value: 540 },
	{ name: "notification-service", value: 380 },
	{ name: "search-service", value: 280 },
	{ name: "analytics-worker", value: 190 },
]

export const pieScenarios: WidgetScenario[] = [
	{
		label: "3 slices",
		dataState: ready(pieFew),
		display: { title: "Traffic by service", pie: {} },
	},
	{
		label: "8 slices (legend overflow)",
		dataState: ready(pieMany),
		display: { title: "Traffic by service", pie: {} },
	},
	{
		label: "Donut + labels",
		dataState: ready(pieFew),
		display: {
			title: "Traffic by service",
			pie: { donut: true, showLabels: true, showPercent: true },
		},
	},
	{
		label: "Single slice (100%)",
		dataState: ready([{ name: "api-gateway", value: 4820 }]),
		display: { title: "Only one source", pie: { showPercent: true } },
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Traffic by service" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Traffic by service" },
	},
]

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

const funnelStages = [
	{ name: "Visited", value: 4820 },
	{ name: "Signed up", value: 2110 },
	{ name: "Activated", value: 940 },
	{ name: "Converted", value: 360 },
]

const funnelManyStages = [
	{ name: "Page view", value: 12840 },
	{ name: "Add to cart", value: 6210 },
	{ name: "Checkout started", value: 3180 },
	{ name: "Payment info", value: 1740 },
	{ name: "Order placed", value: 1120 },
	{ name: "Repeat purchase", value: 410 },
]

export const funnelScenarios: WidgetScenario[] = [
	{
		label: "4 stages (% of first)",
		dataState: ready(funnelStages),
		display: { title: "Signup conversion", unit: "number", funnel: {} },
	},
	{
		label: "Step conversion %",
		dataState: ready(funnelStages),
		display: {
			title: "Signup conversion",
			unit: "number",
			funnel: { showStepPercent: true },
		},
	},
	{
		label: "6 stages",
		dataState: ready(funnelManyStages),
		display: {
			title: "Checkout funnel",
			unit: "number",
			funnel: { showStepPercent: true },
		},
	},
	{
		label: "Single stage (100%)",
		dataState: ready([{ name: "Visited", value: 4820 }]),
		display: { title: "Single stage", unit: "number", funnel: {} },
	},
	{
		// MAP-49: more stages than fit in the card — must cap rows inside the
		// card (+N more), never spill above/below it.
		label: "30 stages (overflow cap)",
		dataState: ready(
			Array.from({ length: 30 }, (_, i) => ({
				name: `stage-${i + 1}`,
				value: Math.max(0, Math.round(12840 / (i + 1))),
			})),
		),
		display: { title: "Deep funnel", unit: "number", funnel: { showStepPercent: true } },
	},
	{
		// MAP-49: mis-wired funnel receiving timeseries rows ({bucket, A}) — must
		// aggregate per series instead of one "—" row per bucket.
		label: "Timeseries-shaped input",
		dataState: ready(
			Array.from({ length: 12 }, (_, i) => ({
				bucket: new Date(new Date("2026-01-01T00:00:00Z").getTime() + i * 3_600_000).toISOString(),
				A: 125,
			})),
		),
		display: { title: "Traces by service", unit: "number", funnel: { showStepPercent: true } },
	},
	{
		// MAP-49: zero-value stages + missing labels — no "0 · 0% ↓ 0%" noise rows.
		label: "Zero stages + missing labels",
		dataState: ready([
			{ name: "Visited", value: 4820 },
			{ name: undefined, value: 940 },
			{ name: "Converted", value: 0 },
			{ name: "Ghost A", value: 0 },
			{ name: "Ghost B", value: 0 },
		]),
		display: { title: "Noisy funnel", unit: "number", funnel: { showStepPercent: true } },
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Signup conversion" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Signup conversion" },
	},
]

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

const bellCurve = [
	{ name: "0-50", value: 8 },
	{ name: "50-100", value: 34 },
	{ name: "100-150", value: 92 },
	{ name: "150-200", value: 148 },
	{ name: "200-250", value: 121 },
	{ name: "250-300", value: 64 },
	{ name: "300-350", value: 28 },
	{ name: "350-400", value: 11 },
	{ name: "400+", value: 4 },
]

const longTail = [
	{ name: "0-10", value: 18420 },
	{ name: "10-50", value: 6210 },
	{ name: "50-100", value: 1840 },
	{ name: "100-500", value: 620 },
	{ name: "500-1k", value: 184 },
	{ name: "1k-5k", value: 42 },
	{ name: "5k-10k", value: 12 },
	{ name: "10k+", value: 3 },
]

const narrowBuckets = Array.from({ length: 30 }).map((_, i) => ({
	name: `${i * 10}-${(i + 1) * 10}`,
	value: Math.round(Math.exp(-((i - 14) ** 2) / 30) * 240 + Math.random() * 8),
}))

export const histogramScenarios: WidgetScenario[] = [
	{
		label: "Bell curve",
		dataState: ready(bellCurve),
		display: { title: "Trace duration", unit: "duration_ms" },
	},
	{
		label: "Long tail (linear)",
		dataState: ready(longTail),
		display: { title: "Trace duration" },
	},
	{
		label: "Long tail (log Y)",
		dataState: ready(longTail),
		display: {
			title: "Trace duration",
			yAxis: { logScale: true },
		},
	},
	{
		label: "Narrow buckets (30)",
		dataState: ready(narrowBuckets),
		display: { title: "Fine-grained" },
	},
	{
		// MAP-49: long range labels must not overlap on the x axis.
		label: "Long range labels (duration)",
		dataState: ready(
			Array.from({ length: 30 }, (_, i) => ({
				name: `${(i * 1.2).toFixed(1)}ms-${((i + 1) * 1.2).toFixed(1)}ms`,
				value: Math.round(Math.exp(-((i - 12) ** 2) / 40) * 180) + 2,
			})),
		),
		display: { title: "Duration distribution", unit: "duration_ms" },
	},
	{
		// MAP-49: raw numeric rows (trace-list durationMs) — chart must bucketize
		// client-side into a real distribution.
		label: "Raw durations (auto-bucketed)",
		dataState: ready(
			Array.from({ length: 200 }, (_, i) => ({
				durationMs: Math.round(
					30 + Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1) * 400 + (i % 17 === 0 ? 900 : 0),
				),
			})),
		),
		display: {
			title: "Trace duration distribution",
			unit: "duration_ms",
			histogram: { bucketCount: 30 },
		},
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Trace duration" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Trace duration" },
	},
]

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

const hours = ["00", "03", "06", "09", "12", "15", "18", "21"]
const buckets = ["0-50ms", "50-100ms", "100-200ms", "200-500ms", "500ms+"]

const denseHeatmap = hours.flatMap((h, hi) =>
	buckets.map((b, bi) => ({
		x: `${h}:00`,
		y: b,
		value: Math.round(20 + Math.sin(hi / 2) * 40 + (buckets.length - bi) * 8 + Math.random() * 5),
	})),
)

const sparseHeatmap = denseHeatmap.filter((_, i) => i % 3 === 0)

const colorScales: Array<"viridis" | "magma" | "cividis" | "blues" | "reds"> = [
	"viridis",
	"magma",
	"cividis",
	"blues",
	"reds",
]

export const heatmapScenarios: WidgetScenario[] = [
	...colorScales.map(
		(scale): WidgetScenario => ({
			label: `Dense — ${scale}`,
			dataState: ready(denseHeatmap),
			display: { title: `Latency × hour (${scale})`, heatmap: { colorScale: scale } },
		}),
	),
	{
		label: "Sparse — viridis",
		dataState: ready(sparseHeatmap),
		display: { title: "Sparse data", heatmap: { colorScale: "viridis" } },
	},
	{
		label: "Log scale — viridis",
		dataState: ready(denseHeatmap),
		display: {
			title: "Log scale",
			heatmap: { colorScale: "viridis", scaleType: "log" },
		},
	},
	{
		// MAP-49: many time rows on the y axis — labels must thin out without
		// the last two colliding.
		label: "24 time rows (y-label stride)",
		dataState: ready(
			Array.from({ length: 24 }, (_, hi) => hi).flatMap((hi) =>
				["Errors", "OK"].map((x, xi) => ({
					x,
					y: `2026-01-01T${String(hi).padStart(2, "0")}:30:00Z`,
					value: xi === 0 ? (hi % 7 === 0 ? 12 : 0) : 90 + Math.round(Math.sin(hi / 3) * 30),
				})),
			),
		),
		display: { title: "Errors vs OK over time", heatmap: { colorScale: "blues" } },
	},
	{
		label: "Loading",
		dataState: loadingState,
		display: { title: "Latency × hour" },
	},
	{
		label: "Empty",
		dataState: emptyState,
		display: { title: "Latency × hour" },
	},
]

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export const markdownScenarios: WidgetScenario[] = [
	{
		label: "Short note",
		dataState: ready(null),
		display: {
			title: "Note",
			markdown: { content: "**Runbook:** if error rate > 5%, page on-call." },
		},
	},
	{
		label: "Rich content",
		dataState: ready(null),
		display: {
			title: "Runbook",
			markdown: {
				content: [
					"# Incident response",
					"",
					"Follow these steps **in order**:",
					"",
					"1. Check the [status page](https://status.example.com)",
					"2. Look at recent deploys",
					"3. Inspect `error_rate` by service",
					"",
					"## Common causes",
					"",
					"- Database connection pool exhaustion",
					"- Upstream provider 5xx",
					"- *Cache stampede* after a deploy",
					"",
					"> If unsure, page the on-call engineer.",
				].join("\n"),
			},
		},
	},
	{
		label: "Empty content",
		dataState: ready(null),
		display: {
			title: "Empty note",
			markdown: { content: "" },
		},
	},
]
