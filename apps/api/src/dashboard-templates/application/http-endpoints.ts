import {
	CHART_DISPLAY_AREA,
	buildPortableDashboard,
	makeQueryBuilderBreakdownDataSource,
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
	return [
		{
			id: "top-endpoints-throughput",
			visualization: "table",
			dataSource: makeQueryBuilderBreakdownDataSource([
				makeQueryDraft({
					id: "top-throughput",
					name: "Throughput",
					dataSource: "traces",
					aggregation: "count",
					whereClause: where,
					groupBy: ["span.name"],
				}),
			]),
			display: {
				title: "Top Endpoints by Throughput",
				columns: [
					{ field: "name", header: "Endpoint" },
					{ field: "value", header: "Requests", align: "right" },
				],
			},
			layout: { x: 0, y: 0, w: 6, h: 5 },
		},
		{
			id: "slowest-endpoints",
			visualization: "table",
			dataSource: makeQueryBuilderBreakdownDataSource([
				makeQueryDraft({
					id: "slowest",
					name: "P95 Latency",
					dataSource: "traces",
					aggregation: "p95_duration",
					whereClause: where,
					groupBy: ["span.name"],
				}),
			]),
			display: {
				title: "Slowest Endpoints (P95)",
				columns: [
					{ field: "name", header: "Endpoint" },
					{ field: "value", header: "P95 Latency", unit: "duration_ms", align: "right" },
				],
			},
			layout: { x: 6, y: 0, w: 6, h: 5 },
		},
		{
			id: "endpoint-error-rate",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "error-rate",
					name: "Error Rate",
					dataSource: "traces",
					aggregation: "error_rate",
					whereClause: where,
					groupBy: ["span.name"],
				}),
			]),
			display: { title: "Error Rate by Endpoint", ...CHART_DISPLAY_AREA },
			layout: { x: 0, y: 5, w: 12, h: 4 },
		},
		{
			id: "recent-traces",
			visualization: "list",
			dataSource: {
				endpoint: "list_traces",
				params: {
					...(serviceName && { service: serviceName }),
					limit: 10,
				},
			},
			display: {
				title: "Recent Traces",
				listDataSource: "traces",
				listLimit: 10,
			},
			layout: { x: 0, y: 9, w: 12, h: 5 },
		},
	]
}

export const httpEndpointsTemplate: TemplateDefinition = {
	id: templateId("http-endpoints"),
	name: "HTTP Endpoints",
	description: "Top endpoints by throughput, slowest endpoints, and error rate by endpoint.",
	category: "application",
	tags: ["http", "endpoints"],
	requirements: ["OpenTelemetry HTTP instrumentation"],
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
		const scope = serviceName ? ` for ${serviceName}` : ""
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — HTTP Endpoints` : "HTTP Endpoints",
			description: `HTTP endpoint performance${scope} — top endpoints, slowest endpoints, and error rates.`,
			tags: ["http"],
			widgets: widgets(serviceName),
		})
	},
}
