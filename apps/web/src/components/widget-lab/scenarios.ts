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
// Chart — iterate every registry entry with its built-in sampleData
// ---------------------------------------------------------------------------

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
				detail:
					"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
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
