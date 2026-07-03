import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	makeQueryDraft,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// Edge metrics land under ServiceName `cloudflare/{zoneName}` (the CloudflareAnalyticsService
// poller); Workers invocation metrics under `cloudflare-worker/{scriptName}`. Counters are
// delta sums (one increment per 5-min bucket), so `sum` — not rate/increase — is the right
// aggregation; percentiles are gauges keyed by the `quantile` attribute.
function zoneWhere(zoneName?: string): string {
	return zoneName ? `service.name = "cloudflare/${zoneName}"` : ""
}

/** Cache hit rate = hit requests / all requests, as a query-builder formula over two hidden queries. */
function cacheHitRateDataSource(where: string): { endpoint: string; params: Record<string, unknown> } {
	const base = {
		dataSource: "metrics" as const,
		aggregation: "sum",
		metricName: "cloudflare.http.requests",
		metricType: "sum",
	}
	return {
		endpoint: "custom_query_builder_timeseries",
		params: {
			queries: [
				{
					...makeQueryDraft({
						...base,
						id: "cf-cache-hits",
						name: "A",
						whereClause: combineWhere(where, `attr.cache.status = "hit"`),
					}),
					hidden: true,
				},
				{
					...makeQueryDraft({ ...base, id: "cf-cache-total", name: "B", whereClause: where }),
					hidden: true,
				},
			],
			formulas: [
				{
					id: "cf-cache-hit-rate",
					name: "Cache hit rate",
					expression: "A / B * 100",
					legend: "hit rate %",
				},
			],
			comparison: { mode: "none", includePercentChange: true },
			debug: false,
		},
	}
}

function widgets(zoneName?: string): WidgetDef[] {
	const where = zoneWhere(zoneName)
	return [
		{
			id: "requests-by-status",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-requests-status",
				name: "Requests",
				metricName: "cloudflare.http.requests",
				metricType: "sum",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["attr.http.status_class"],
			}),
			display: { title: "Edge Requests by Status", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "cache-hit-rate",
			visualization: "chart",
			dataSource: cacheHitRateDataSource(where),
			display: { title: "Cache Hit Rate", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "requests-by-cache-status",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-requests-cache",
				name: "Requests",
				metricName: "cloudflare.http.requests",
				metricType: "sum",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["attr.cache.status"],
			}),
			display: { title: "Requests by Cache Status", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "edge-ttfb",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-edge-ttfb",
				name: "Edge TTFB",
				metricName: "cloudflare.http.edge.ttfb",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.quantile"],
			}),
			display: { title: "Edge TTFB (p50/p95/p99)", ...CHART_DISPLAY_LINE, unit: "ms" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "origin-duration",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-origin-duration",
				name: "Origin Response Duration",
				metricName: "cloudflare.http.origin.duration",
				metricType: "gauge",
				whereClause: where,
				groupBy: ["attr.quantile"],
			}),
			display: { title: "Origin Response Duration", ...CHART_DISPLAY_LINE, unit: "ms" },
			layout: { x: 0, y: 8, w: 6, h: 4 },
		},
		{
			id: "bytes-served",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-bytes",
				name: "Bytes Served",
				metricName: "cloudflare.http.bytes",
				metricType: "sum",
				aggregation: "sum",
				whereClause: where,
				groupBy: ["attr.cache.status"],
			}),
			display: { title: "Bytes Served", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 6, y: 8, w: 6, h: 4 },
		},
		{
			id: "worker-requests",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-worker-requests",
				name: "Worker Requests",
				metricName: "cloudflare.worker.requests",
				metricType: "sum",
				aggregation: "sum",
				groupBy: ["resource.service.name"],
			}),
			display: { title: "Worker Invocations by Script", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 12, w: 6, h: 4 },
		},
		{
			id: "worker-cpu",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-worker-cpu",
				name: "Worker CPU p99",
				metricName: "cloudflare.worker.cpu_time",
				metricType: "gauge",
				whereClause: `attr.quantile = "0.99"`,
				groupBy: ["resource.service.name"],
			}),
			display: { title: "Worker CPU Time p99 by Script", ...CHART_DISPLAY_LINE, unit: "ms" },
			layout: { x: 6, y: 12, w: 6, h: 4 },
		},
	]
}

export const cloudflareTemplate: TemplateDefinition = {
	id: templateId("cloudflare"),
	name: "Cloudflare Edge",
	description:
		"Edge traffic from the Cloudflare integration — requests by status, cache hit rate, TTFB and origin latency percentiles, bytes, and Workers metrics.",
	category: "infrastructure",
	tags: ["cloudflare", "edge", "cdn"],
	requirements: ["Cloudflare integration connected with analytics permissions"],
	requiredMetricPrefixes: ["cloudflare."],
	parameters: [
		{
			key: paramKey("zone_name"),
			label: "Zone",
			description: "Optional — scope the HTTP widgets to a single Cloudflare zone.",
			required: false,
			placeholder: "example.com",
		},
	],
	build: (params) => {
		const zoneName = paramValue(params, "zone_name")
		return buildPortableDashboard({
			name: zoneName ? `${zoneName} — Cloudflare Edge` : "Cloudflare Edge",
			description:
				"Cloudflare edge analytics — requests, cache hit rate, latency percentiles, and Workers.",
			tags: ["cloudflare"],
			widgets: widgets(zoneName),
		})
	},
}
