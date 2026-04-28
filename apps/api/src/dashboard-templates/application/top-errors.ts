import {
	CHART_DISPLAY_AREA,
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
	return [
		{
			id: "total-errors",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				params: serviceName ? { services: [serviceName] } : {},
				transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
			},
			display: { title: "Total Errors", unit: "number" },
			layout: { x: 0, y: 0, w: 4, h: 2 },
		},
		{
			id: "error-rate",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				params: serviceName ? { services: [serviceName] } : {},
				transform: { reduceToValue: { field: "errorRate", aggregate: "first" } },
			},
			display: { title: "Error Rate", unit: "percent" },
			layout: { x: 4, y: 0, w: 4, h: 2 },
		},
		{
			id: "affected-services",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				params: serviceName ? { services: [serviceName] } : {},
				transform: { reduceToValue: { field: "affectedServicesCount", aggregate: "first" } },
			},
			display: { title: "Affected Services", unit: "number" },
			layout: { x: 8, y: 0, w: 4, h: 2 },
		},
		{
			id: "errors-by-type",
			visualization: "table",
			dataSource: {
				endpoint: "errors_by_type",
				params: {
					...(serviceName && { services: [serviceName] }),
					limit: 20,
				},
			},
			display: {
				title: "Errors by Type",
				columns: [
					{ field: "errorType", header: "Error Type" },
					{ field: "count", header: "Count", align: "right" },
					{ field: "affectedServicesCount", header: "Services", align: "right" },
				],
			},
			layout: { x: 0, y: 2, w: 12, h: 5 },
		},
		{
			id: "error-rate-ts",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "error-rate",
					name: "Error Rate",
					dataSource: "traces",
					aggregation: "error_rate",
					whereClause: where,
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
			layout: { x: 0, y: 7, w: 12, h: 4 },
		},
		{
			id: "recent-error-traces",
			visualization: "list",
			dataSource: {
				endpoint: "list_traces",
				params: {
					...(serviceName && { service: serviceName }),
					hasError: true,
					limit: 10,
				},
			},
			display: {
				title: "Recent Error Traces",
				listDataSource: "traces",
				listWhereClause: "has_error = true",
				listLimit: 10,
			},
			layout: { x: 0, y: 11, w: 12, h: 5 },
		},
	]
}

export const topErrorsTemplate: TemplateDefinition = {
	id: templateId("top-errors"),
	name: "Top Errors",
	description: "Error counts, top error types, error rate trend, and recent error traces.",
	category: "application",
	tags: ["errors"],
	requirements: ["OpenTelemetry tracing"],
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
			name: serviceName ? `${serviceName} — Top Errors` : "Top Errors",
			description: `Error investigation${scope} — error counts, types, trends, and recent error traces.`,
			tags: ["errors"],
			widgets: widgets(serviceName),
		})
	},
}
