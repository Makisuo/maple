import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	makeQueryBuilderBreakdownDataSource,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

const GRPC_FILTER = `rpc.system = "grpc"`

function widgets(serviceName?: string): WidgetDef[] {
	const where = combineWhere(GRPC_FILTER, serviceWhereClause(serviceName))
	return [
		{
			id: "rps-by-status",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "grpc-rps",
					name: "Requests / sec",
					dataSource: "traces",
					aggregation: "count",
					whereClause: where,
					groupBy: ["status.code"],
				}),
			]),
			display: { title: "Requests by Status Code", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "error-rate",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "grpc-error-rate",
					name: "Error Rate",
					dataSource: "traces",
					aggregation: "error_rate",
					whereClause: where,
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "Error Rate", ...CHART_DISPLAY_AREA },
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
		{
			id: "p50-latency",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "grpc-p50",
					name: "P50",
					dataSource: "traces",
					aggregation: "p50_duration",
					whereClause: where,
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "P50 Latency", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
			layout: { x: 0, y: 4, w: 6, h: 4 },
		},
		{
			id: "p95-latency",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "grpc-p95",
					name: "P95",
					dataSource: "traces",
					aggregation: "p95_duration",
					whereClause: where,
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "P95 Latency", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
			layout: { x: 6, y: 4, w: 6, h: 4 },
		},
		{
			id: "top-methods",
			visualization: "table",
			dataSource: makeQueryBuilderBreakdownDataSource([
				makeQueryDraft({
					id: "grpc-top-methods",
					name: "Throughput",
					dataSource: "traces",
					aggregation: "count",
					whereClause: where,
					groupBy: ["span.name"],
				}),
			]),
			display: {
				title: "Top gRPC Methods",
				columns: [
					{ field: "name", header: "Method" },
					{ field: "value", header: "Requests", align: "right" },
				],
			},
			layout: { x: 0, y: 8, w: 12, h: 5 },
		},
	]
}

export const grpcServiceTemplate: TemplateDefinition = {
	id: templateId("grpc-service"),
	name: "gRPC Service",
	description: "RPS by status, error rate, P50/P95 latency, and top methods for gRPC services.",
	category: "application",
	tags: ["grpc", "rpc"],
	requirements: ["OpenTelemetry gRPC instrumentation"],
	parameters: [
		{
			key: paramKey("service_name"),
			label: "Service name",
			description: "Optional — scope to a single service.",
			required: false,
			placeholder: "user-service",
		},
	],
	build: (params) => {
		const serviceName = paramValue(params, "service_name")
		return buildPortableDashboard({
			name: serviceName ? `${serviceName} — gRPC Service` : "gRPC Service",
			description: "gRPC service performance — RPS, error rate, latency, and top methods.",
			tags: ["grpc"],
			widgets: widgets(serviceName),
		})
	},
}
