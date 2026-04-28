import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
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
			id: "throughput",
			visualization: "stat",
			dataSource: {
				endpoint: "service_overview",
				params: serviceName ? { service_name: serviceName } : {},
				transform: { reduceToValue: { field: "throughput", aggregate: "sum" } },
			},
			display: { title: "Throughput", unit: "number" },
			layout: { x: 0, y: 0, w: 3, h: 2 },
		},
		{
			id: "error-rate",
			visualization: "stat",
			dataSource: {
				...makeQueryBuilderTimeseriesDataSource([
					makeQueryDraft({
						id: "error-rate-stat",
						name: "Error Rate",
						dataSource: "traces",
						aggregation: "error_rate",
						whereClause: where,
						groupBy: [],
					}),
				]),
				transform: { reduceToValue: { field: "Error Rate", aggregate: "avg" } },
			},
			display: { title: "Error Rate", unit: "percent" },
			layout: { x: 3, y: 0, w: 3, h: 2 },
		},
		{
			id: "p50",
			visualization: "stat",
			dataSource: {
				endpoint: "service_overview",
				params: serviceName ? { service_name: serviceName } : {},
				transform: { reduceToValue: { field: "p50LatencyMs", aggregate: "avg" } },
			},
			display: { title: "P50 Latency", unit: "duration_ms" },
			layout: { x: 6, y: 0, w: 3, h: 2 },
		},
		{
			id: "p95",
			visualization: "stat",
			dataSource: {
				endpoint: "service_overview",
				params: serviceName ? { service_name: serviceName } : {},
				transform: { reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
			},
			display: { title: "P95 Latency", unit: "duration_ms" },
			layout: { x: 9, y: 0, w: 3, h: 2 },
		},
		{
			id: "throughput-chart",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "throughput",
					name: "Throughput",
					dataSource: "traces",
					aggregation: "count",
					whereClause: where,
					groupBy,
				}),
			]),
			display: { title: "Throughput Over Time", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 2, w: 6, h: 4 },
		},
		{
			id: "error-rate-chart",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "error-rate",
					name: "Error Rate",
					dataSource: "traces",
					aggregation: "error_rate",
					whereClause: where,
					groupBy,
				}),
			]),
			display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
			layout: { x: 6, y: 2, w: 6, h: 4 },
		},
		{
			id: "latency-chart",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "p95-latency",
					name: "P95 Latency",
					dataSource: "traces",
					aggregation: "p95_duration",
					whereClause: where,
					groupBy,
				}),
			]),
			display: { title: "P95 Latency Over Time", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
			layout: { x: 0, y: 6, w: 12, h: 4 },
		},
	]
}

export const serviceHealthTemplate: TemplateDefinition = {
	id: templateId("service-health"),
	name: "Service Health",
	description: "Throughput, error rate, and P50/P95 latency for one or all services.",
	category: "application",
	tags: ["service-health"],
	requirements: ["OpenTelemetry tracing"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope all widgets to a single service.",
			required: false,
			placeholder: "checkout-api",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		const scope = serviceName ? ` for ${serviceName}` : ""
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — Service Health` : "Service Health",
			description: `Service health overview${scope} — throughput, error rate, and latency.`,
			tags: ["service-health"],
			widgets: widgets(serviceName),
		})
	},
}
