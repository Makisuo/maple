import {
	buildPortableDashboard,
	chartDisplayForMetric,
	makeQueryBuilderBreakdownDataSource,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

function widgets(opts: {
	metricName: string
	metricType: string
	serviceName?: string
	aggregation?: string
}): WidgetDef[] {
	const agg = opts.aggregation ?? "avg"
	const where = serviceWhereClause(opts.serviceName)
	const metricsFilters: Record<string, unknown> = {
		metricName: opts.metricName,
		metricType: opts.metricType,
		...(opts.serviceName && { serviceName: opts.serviceName }),
	}
	return [
		{
			id: "metric-current",
			visualization: "stat",
			dataSource: {
				endpoint: "custom_timeseries",
				params: { source: "metrics", metric: agg, groupBy: "none", filters: metricsFilters },
				transform: {
					flattenSeries: { valueField: "value" },
					reduceToValue: { field: "value", aggregate: "avg" },
				},
			},
			display: { title: `${opts.metricName} (${agg})` },
			layout: { x: 0, y: 0, w: 4, h: 2 },
		},
		{
			id: "metric-max",
			visualization: "stat",
			dataSource: {
				endpoint: "custom_timeseries",
				params: { source: "metrics", metric: "max", groupBy: "none", filters: metricsFilters },
				transform: {
					flattenSeries: { valueField: "value" },
					reduceToValue: { field: "value", aggregate: "max" },
				},
			},
			display: { title: `${opts.metricName} (max)` },
			layout: { x: 4, y: 0, w: 4, h: 2 },
		},
		{
			id: "metric-count",
			visualization: "stat",
			dataSource: {
				endpoint: "custom_timeseries",
				params: { source: "metrics", metric: "count", groupBy: "none", filters: metricsFilters },
				transform: {
					flattenSeries: { valueField: "value" },
					reduceToValue: { field: "value", aggregate: "sum" },
				},
			},
			display: { title: "Data Points", unit: "number" },
			layout: { x: 8, y: 0, w: 4, h: 2 },
		},
		{
			id: "metric-timeseries",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "metric-ts",
					name: opts.metricName,
					dataSource: "metrics",
					aggregation: agg,
					whereClause: where,
					groupBy: ["service.name"],
					metricName: opts.metricName,
					metricType: opts.metricType,
				}),
			]),
			display: { title: `${opts.metricName} Over Time`, ...chartDisplayForMetric(agg) },
			layout: { x: 0, y: 2, w: 12, h: 4 },
		},
		{
			id: "metric-breakdown",
			visualization: "table",
			dataSource: makeQueryBuilderBreakdownDataSource([
				makeQueryDraft({
					id: "metric-bd",
					name: opts.metricName,
					dataSource: "metrics",
					aggregation: agg,
					whereClause: where,
					groupBy: ["service.name"],
					metricName: opts.metricName,
					metricType: opts.metricType,
				}),
			]),
			display: {
				title: "By Service",
				columns: [
					{ field: "name", header: "Service" },
					{ field: "value", header: agg.charAt(0).toUpperCase() + agg.slice(1) },
				],
			},
			layout: { x: 0, y: 6, w: 12, h: 4 },
		},
	]
}

export const metricOverviewTemplate: TemplateDefinition = {
	id: templateId("metric-overview"),
	name: "Metric Overview",
	description: "Current value, time series, and per-service breakdown for any metric.",
	category: "application",
	tags: ["metrics"],
	requirements: ["OpenTelemetry metrics"],
	parameters: [
		{
			key: paramKey("metric_name"),
			label: "Metric name",
			description: "Required — the metric to chart (e.g. http.server.duration).",
			required: true,
			placeholder: "http.server.duration",
		},
		{
			key: paramKey("metric_type"),
			label: "Metric type",
			description: "Required — sum, gauge, histogram, or exponential_histogram.",
			required: true,
			placeholder: "histogram",
		},
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a single service.",
			required: false,
			placeholder: "checkout-api",
		},
	],
	build: (params) => {
		const metricName = paramValue(params, "metric_name") ?? ""
		const metricType = paramValue(params, "metric_type") ?? "sum"
		const serviceName = paramValue(params, "service_name")
		const scope = serviceName ? ` for ${serviceName}` : ""
		return buildPortableDashboard({
			name: `${metricName || "Metric"} Overview`,
			description: `Metric overview${scope} — current values, time series, and service breakdown.`,
			tags: ["metric-overview"],
			widgets: widgets({ metricName, metricType, serviceName }),
		})
	},
}
