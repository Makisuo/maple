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
	const groupBy = ["service.name"]
	return [
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
					groupBy,
				}),
			]),
			display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
			layout: { x: 0, y: 0, w: 12, h: 4 },
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
					{ field: "count", header: "Count" },
					{ field: "affectedServicesCount", header: "Services" },
				],
			},
			layout: { x: 0, y: 4, w: 12, h: 5 },
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
				listLimit: 10,
			},
			layout: { x: 0, y: 9, w: 12, h: 5 },
		},
	]
}

export const errorTrackingTemplate: TemplateDefinition = {
	id: templateId("error-tracking"),
	name: "Error Tracking",
	description: "Error rate trends, error types breakdown, and recent error traces.",
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
			name: serviceName ? `${serviceName} — Error Tracking` : "Error Tracking",
			description: `Error tracking${scope} — error rate trends, error types, and recent error traces.`,
			tags: ["errors"],
			widgets: widgets(serviceName),
		})
	},
}
