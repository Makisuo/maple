import {
	CHART_DISPLAY_AREA,
	buildPortableDashboard,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

function widgets(): WidgetDef[] {
	return [
		{
			id: "total-throughput",
			visualization: "stat",
			dataSource: {
				endpoint: "service_usage",
				transform: { reduceToValue: { field: "totalTraceCount", aggregate: "sum" } },
			},
			display: { title: "Total Traces", unit: "number" },
			layout: { x: 0, y: 0, w: 3, h: 2 },
		},
		{
			id: "total-errors",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
			},
			display: { title: "Total Errors", unit: "number" },
			layout: { x: 3, y: 0, w: 3, h: 2 },
		},
		{
			id: "error-rate",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				transform: { reduceToValue: { field: "errorRate", aggregate: "first" } },
			},
			display: { title: "Error Rate", unit: "percent" },
			layout: { x: 6, y: 0, w: 3, h: 2 },
		},
		{
			id: "affected-services",
			visualization: "stat",
			dataSource: {
				endpoint: "errors_summary",
				transform: { reduceToValue: { field: "affectedServicesCount", aggregate: "first" } },
			},
			display: { title: "Affected Services", unit: "number" },
			layout: { x: 9, y: 0, w: 3, h: 2 },
		},
		{
			id: "service-overview",
			visualization: "table",
			dataSource: { endpoint: "service_overview" },
			display: {
				title: "Service Overview",
				columns: [
					{ field: "serviceName", header: "Service" },
					{ field: "throughput", header: "Throughput", unit: "number", align: "right" },
					{ field: "p95LatencyMs", header: "P95", unit: "duration_ms", align: "right" },
					{ field: "errorCount", header: "Errors", unit: "number", align: "right" },
				],
			},
			layout: { x: 0, y: 2, w: 12, h: 5 },
		},
		{
			id: "throughput-by-service",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "throughput",
					name: "Throughput",
					dataSource: "traces",
					aggregation: "count",
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "Throughput by Service", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 7, w: 6, h: 4 },
		},
		{
			id: "error-rate-by-service",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "error-rate",
					name: "Error Rate",
					dataSource: "traces",
					aggregation: "error_rate",
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "Error Rate by Service", ...CHART_DISPLAY_AREA },
			layout: { x: 6, y: 7, w: 6, h: 4 },
		},
		{
			id: "recent-error-traces",
			visualization: "list",
			dataSource: {
				endpoint: "list_traces",
				params: { hasError: true, limit: 10 },
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

export const platformOverviewTemplate: TemplateDefinition = {
	id: templateId("platform-overview"),
	name: "Platform Overview",
	description: "Cross-service health: throughput, error rates, service table, and recent errors.",
	category: "application",
	tags: ["platform", "overview"],
	requirements: ["OpenTelemetry tracing"],
	parameters: [],
	build: () =>
		buildPortableDashboard({
			name: "Platform Overview",
			description:
				"Platform overview — cross-service health, throughput, error rates, and recent errors.",
			tags: ["platform-overview"],
			widgets: widgets(),
		}),
}
