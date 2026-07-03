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

type DataSource = { endpoint: string; params: Record<string, unknown> }

/**
 * A / B * 100 ratio over `cloudflare.http.requests`, as two hidden query-builder queries plus a
 * formula. Powers both the KPI stat and the over-time chart for cache hit rate and 5xx error rate
 * (the numerator is the single equality attr-filter the metrics query-builder supports).
 */
function requestsRatioDataSource(opts: {
	idPrefix: string
	where: string
	numeratorWhere: string
	formulaName: string
	legend: string
}): DataSource {
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
						id: `${opts.idPrefix}-num`,
						name: "A",
						whereClause: combineWhere(opts.where, opts.numeratorWhere),
					}),
					hidden: true,
				},
				{
					...makeQueryDraft({ ...base, id: `${opts.idPrefix}-den`, name: "B", whereClause: opts.where }),
					hidden: true,
				},
			],
			formulas: [
				{ id: `${opts.idPrefix}-ratio`, name: opts.formulaName, expression: "A / B * 100", legend: opts.legend },
			],
			comparison: { mode: "none", includePercentChange: true },
			debug: false,
		},
	}
}

const CACHE_HIT_RATE = {
	idPrefix: "cf-cache-hit",
	numeratorWhere: `attr.cache.status = "hit"`,
	formulaName: "Cache hit rate",
	legend: "hit rate %",
} as const

const ERROR_RATE = {
	idPrefix: "cf-error-rate",
	numeratorWhere: `attr.http.status_class = "5xx"`,
	formulaName: "5xx error rate",
	legend: "5xx %",
} as const

/** A single-metric stat: reduce one query-builder series to one number. */
function metricStat(opts: {
	id: string
	name: string
	metricName: string
	where: string
	aggregate: "sum" | "avg"
	unit: string
	title: string
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "stat",
		dataSource: {
			...metricsTimeseries({
				id: opts.id,
				name: opts.name,
				metricName: opts.metricName,
				metricType: "sum",
				aggregation: "sum",
				whereClause: opts.where,
			}),
			transform: { reduceToValue: { field: opts.name, aggregate: opts.aggregate } },
		},
		display: { title: opts.title, unit: opts.unit },
		layout: opts.layout,
	}
}

/** A ratio stat: reduce the A/B*100 formula series (its legend field) to its window average. */
function ratioStat(opts: {
	id: string
	ratio: typeof CACHE_HIT_RATE | typeof ERROR_RATE
	where: string
	title: string
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "stat",
		dataSource: {
			...requestsRatioDataSource({ ...opts.ratio, where: opts.where }),
			transform: { reduceToValue: { field: opts.ratio.legend, aggregate: "avg" } },
		},
		display: { title: opts.title, unit: "percent" },
		layout: opts.layout,
	}
}

function widgets(zoneName?: string): WidgetDef[] {
	const where = zoneWhere(zoneName)
	return [
		// -- KPI row -----------------------------------------------------------
		metricStat({
			id: "kpi-requests",
			name: "Requests",
			metricName: "cloudflare.http.requests",
			where,
			aggregate: "sum",
			unit: "number",
			title: "Total Requests",
			layout: { x: 0, y: 0, w: 3, h: 2 },
		}),
		ratioStat({
			id: "kpi-cache-hit-rate",
			ratio: CACHE_HIT_RATE,
			where,
			title: "Cache Hit Rate",
			layout: { x: 3, y: 0, w: 3, h: 2 },
		}),
		ratioStat({
			id: "kpi-error-rate",
			ratio: ERROR_RATE,
			where,
			title: "5xx Error Rate",
			layout: { x: 6, y: 0, w: 3, h: 2 },
		}),
		metricStat({
			id: "kpi-bytes",
			name: "Bytes",
			metricName: "cloudflare.http.bytes",
			where,
			aggregate: "sum",
			unit: "bytes",
			title: "Bandwidth Served",
			layout: { x: 9, y: 0, w: 3, h: 2 },
		}),

		// -- Traffic & cache ---------------------------------------------------
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
			layout: { x: 0, y: 2, w: 6, h: 4 },
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
			layout: { x: 6, y: 2, w: 6, h: 4 },
		},
		{
			id: "cache-hit-rate",
			visualization: "chart",
			dataSource: requestsRatioDataSource({ ...CACHE_HIT_RATE, where }),
			display: { title: "Cache Hit Rate", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 0, y: 6, w: 6, h: 4 },
		},
		{
			id: "error-rate",
			visualization: "chart",
			dataSource: requestsRatioDataSource({ ...ERROR_RATE, where }),
			display: { title: "5xx Error Rate", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 6, y: 6, w: 6, h: 4 },
		},

		// -- Latency -----------------------------------------------------------
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
			layout: { x: 0, y: 10, w: 6, h: 4 },
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
			display: { title: "Origin Response Duration (p50/p95/p99)", ...CHART_DISPLAY_LINE, unit: "ms" },
			layout: { x: 6, y: 10, w: 6, h: 4 },
		},

		// -- Bandwidth & Workers ----------------------------------------------
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
			display: { title: "Bytes Served by Cache Status", ...CHART_DISPLAY_AREA, unit: "bytes" },
			layout: { x: 0, y: 14, w: 6, h: 4 },
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
			layout: { x: 6, y: 14, w: 6, h: 4 },
		},
		{
			id: "worker-errors",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "cf-worker-errors",
				name: "Worker Errors",
				metricName: "cloudflare.worker.errors",
				metricType: "sum",
				aggregation: "sum",
				groupBy: ["resource.service.name"],
			}),
			display: { title: "Worker Errors by Script", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 18, w: 6, h: 4 },
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
			layout: { x: 6, y: 18, w: 6, h: 4 },
		},
	]
}

export const cloudflareTemplate: TemplateDefinition = {
	id: templateId("cloudflare"),
	name: "Cloudflare Edge",
	description:
		"Edge traffic from the Cloudflare integration — total requests, cache hit rate, 5xx error rate and bandwidth KPIs, plus requests by status/cache, TTFB and origin latency percentiles, and Workers invocations, errors, and CPU.",
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
				"Cloudflare edge analytics — traffic, cache hit rate, error rate, latency percentiles, and Workers.",
			tags: ["cloudflare"],
			timeRange: "24h",
			widgets: widgets(zoneName),
		})
	},
}
