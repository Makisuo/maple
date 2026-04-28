import {
	PulseIcon,
	FileIcon,
	AlertWarningIcon,
	XmarkIcon,
	GridIcon,
	ChartBarIcon,
	ChartLineIcon,
	type IconComponent,
} from "@/components/icons"
import { createQueryDraft } from "@/lib/query-builder/model"
import type {
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"

export interface WidgetPresetDefinition {
	id: string
	name: string
	description: string
	visualization: VisualizationType
	dataSource: WidgetDataSource
	display: WidgetDisplayConfig
	icon?: IconComponent
}

export const statPresets: WidgetPresetDefinition[] = [
	{
		id: "stat-total-traces",
		name: "Total Traces",
		description: "Sum of traces across all services",
		icon: PulseIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "service_usage",
			transform: {
				reduceToValue: { field: "totalTraces", aggregate: "sum" },
			},
		},
		display: {
			title: "Total Traces",
			unit: "number",
		},
	},
	{
		id: "stat-total-logs",
		name: "Total Logs",
		description: "Sum of logs across all services",
		icon: FileIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "service_usage",
			transform: {
				reduceToValue: { field: "totalLogs", aggregate: "sum" },
			},
		},
		display: {
			title: "Total Logs",
			unit: "number",
		},
	},
	{
		id: "stat-error-rate",
		name: "Error Rate",
		description: "Overall error rate as percentage",
		icon: AlertWarningIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "errors_summary",
			transform: {
				reduceToValue: { field: "errorRate", aggregate: "first" },
			},
		},
		display: {
			title: "Error Rate",
			unit: "percent",
		},
	},
	{
		id: "stat-total-errors",
		name: "Total Errors",
		description: "Total number of errors",
		icon: XmarkIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "errors_summary",
			transform: {
				reduceToValue: { field: "totalErrors", aggregate: "first" },
			},
		},
		display: {
			title: "Total Errors",
			unit: "number",
		},
	},
	{
		id: "stat-root-error-rate",
		name: "Root Error Rate",
		description: "Error rate for root spans only",
		icon: AlertWarningIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "errors_summary",
			params: { rootOnly: true },
			transform: {
				reduceToValue: { field: "errorRate", aggregate: "first" },
			},
		},
		display: {
			title: "Root Error Rate",
			unit: "percent",
		},
	},
	{
		id: "stat-root-total-errors",
		name: "Root Errors",
		description: "Total number of errors on root spans",
		icon: XmarkIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "errors_summary",
			params: { rootOnly: true },
			transform: {
				reduceToValue: { field: "totalErrors", aggregate: "first" },
			},
		},
		display: {
			title: "Root Errors",
			unit: "number",
		},
	},
	{
		id: "stat-total-services",
		name: "Active Services",
		description: "Number of active services",
		icon: GridIcon,
		visualization: "stat",
		dataSource: {
			endpoint: "service_usage",
			transform: {
				reduceToValue: { field: "serviceName", aggregate: "count" },
			},
		},
		display: {
			title: "Active Services",
			unit: "number",
		},
	},
]

export const listPresets: WidgetPresetDefinition[] = [
	{
		id: "list-traces",
		name: "Recent Traces",
		description: "Latest traces with service, duration, and status",
		visualization: "list",
		dataSource: {
			endpoint: "custom_query_builder_list",
			params: {
				queries: [
					{
						id: "preset-list-traces",
						name: "A",
						enabled: true,
						dataSource: "traces",
						signalSource: "default",
						metricName: "",
						metricType: "sum",
						isMonotonic: false,
						whereClause: "root_only = true",
						aggregation: "count",
						stepInterval: "",
						orderByDirection: "desc",
						addOns: {
							groupBy: false,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
						groupBy: [],
						having: "",
						orderBy: "",
						limit: "",
						legend: "",
					},
				],
				limit: 25,
			},
		},
		display: {
			title: "Recent Traces",
			listDataSource: "traces",
			listWhereClause: "",
			listLimit: 25,
			listRootOnly: true,
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "spanName", header: "Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "statusCode", header: "Status" },
			],
		},
	},
	{
		id: "list-error-traces",
		name: "Error Traces",
		description: "Traces with errors",
		visualization: "list",
		dataSource: {
			endpoint: "custom_query_builder_list",
			params: {
				queries: [
					{
						id: "preset-list-errors",
						name: "A",
						enabled: true,
						dataSource: "traces",
						signalSource: "default",
						metricName: "",
						metricType: "sum",
						isMonotonic: false,
						whereClause: "root_only = true AND has_error = true",
						aggregation: "count",
						stepInterval: "",
						orderByDirection: "desc",
						addOns: {
							groupBy: false,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
						groupBy: [],
						having: "",
						orderBy: "",
						limit: "",
						legend: "",
					},
				],
				limit: 25,
			},
		},
		display: {
			title: "Error Traces",
			listDataSource: "traces",
			listWhereClause: "has_error = true",
			listLimit: 25,
			listRootOnly: true,
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "spanName", header: "Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "statusCode", header: "Status" },
			],
		},
	},
	{
		id: "list-logs",
		name: "Recent Logs",
		description: "Latest log entries",
		visualization: "list",
		dataSource: {
			endpoint: "list_logs",
			params: { limit: 25 },
		},
		display: {
			title: "Recent Logs",
			listDataSource: "logs",
			listWhereClause: "",
			listLimit: 25,
			columns: [
				{ field: "timestamp", header: "Time" },
				{ field: "severityText", header: "Severity" },
				{ field: "serviceName", header: "Service" },
				{ field: "body", header: "Message" },
			],
		},
	},
]

function buildBreakdownQuery(
	index: number,
	overrides: Partial<ReturnType<typeof createQueryDraft>>,
): ReturnType<typeof createQueryDraft> {
	return {
		...createQueryDraft(index),
		enabled: true,
		addOns: { groupBy: true, having: false, orderBy: false, limit: true, legend: false },
		limit: "10",
		...overrides,
	}
}

export const piePresets: WidgetPresetDefinition[] = [
	{
		id: "pie-errors-by-service",
		name: "Errors by Service",
		description: "Distribution of errors across services",
		icon: AlertWarningIcon,
		visualization: "pie",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						dataSource: "traces",
						whereClause: "has_error = true",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Errors by Service",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: true, showLabels: false, showPercent: true },
		},
	},
	{
		id: "pie-logs-by-severity",
		name: "Logs by Severity",
		description: "Distribution of log volume by severity level",
		icon: FileIcon,
		visualization: "pie",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						dataSource: "logs",
						whereClause: "",
						aggregation: "count",
						groupBy: ["severity_text"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Logs by Severity",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: false, showLabels: true, showPercent: true },
		},
	},
	{
		id: "pie-traces-by-service",
		name: "Traces by Service",
		description: "Distribution of trace volume across services",
		icon: PulseIcon,
		visualization: "pie",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						dataSource: "traces",
						whereClause: "root_only = true",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Traces by Service",
			chartId: "query-builder-pie",
			unit: "number",
			pie: { donut: true, showLabels: false, showPercent: true },
		},
	},
]

export const histogramPresets: WidgetPresetDefinition[] = [
	{
		id: "histogram-trace-duration",
		name: "Trace Duration Distribution",
		description: "Spread of root span durations across buckets",
		icon: ChartBarIcon,
		visualization: "histogram",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						dataSource: "traces",
						whereClause: "root_only = true",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Trace Duration Distribution",
			chartId: "query-builder-histogram",
			unit: "number",
			histogram: { bucketCount: 30 },
		},
	},
	{
		id: "histogram-log-volume",
		name: "Log Volume by Service",
		description: "Distribution of log volume across services",
		icon: ChartBarIcon,
		visualization: "histogram",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						dataSource: "logs",
						whereClause: "",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Log Volume by Service",
			chartId: "query-builder-histogram",
			unit: "number",
			histogram: { bucketCount: 20 },
		},
	},
]

export const heatmapPresets: WidgetPresetDefinition[] = [
	{
		id: "heatmap-errors-by-service",
		name: "Errors by Service",
		description: "Density of errors across services and types",
		icon: ChartLineIcon,
		visualization: "heatmap",
		dataSource: {
			endpoint: "custom_query_builder_breakdown",
			params: {
				queries: [
					buildBreakdownQuery(0, {
						name: "A",
						dataSource: "traces",
						whereClause: "has_error = true",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
					buildBreakdownQuery(1, {
						name: "B",
						dataSource: "traces",
						whereClause: "has_error = false",
						aggregation: "count",
						groupBy: ["service_name"],
					}),
				],
				formulas: [],
				comparison: { mode: "none", includePercentChange: false },
				debug: false,
			},
		},
		display: {
			title: "Errors vs OK by Service",
			chartId: "query-builder-heatmap",
			unit: "number",
			heatmap: { colorScale: "blues" },
		},
	},
]

export const markdownPresets: WidgetPresetDefinition[] = [
	{
		id: "markdown-note",
		name: "Note",
		description: "Static markdown note for context, links, or runbooks",
		icon: FileIcon,
		visualization: "markdown",
		dataSource: { endpoint: "markdown_static" },
		display: {
			title: "Note",
			markdown: {
				content:
					"# Dashboard notes\n\nDocument **what this dashboard tracks**, link to runbooks, or leave context for teammates.\n\n- Edit this widget to customize\n- Supports headings, lists, links, **bold**, *italic*, and `code`",
			},
		},
	},
]

export const tablePresets: WidgetPresetDefinition[] = [
	{
		id: "table-traces",
		name: "Recent Traces",
		description: "Latest traces with duration and status",
		visualization: "table",
		dataSource: {
			endpoint: "list_traces",
			params: { limit: 5 },
			transform: { limit: 5 },
		},
		display: {
			title: "Recent Traces",
			columns: [
				{ field: "rootSpanName", header: "Root Span" },
				{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
				{ field: "hasError", header: "Status", align: "right" },
			],
		},
	},
	{
		id: "table-errors",
		name: "Errors by Type",
		description: "Error types with counts and affected services",
		visualization: "table",
		dataSource: {
			endpoint: "errors_by_type",
			params: { limit: 5 },
			transform: { limit: 5 },
		},
		display: {
			title: "Errors by Type",
			columns: [
				{ field: "errorType", header: "Error Type" },
				{ field: "count", header: "Count", unit: "number", align: "right" },
				{ field: "affectedServicesCount", header: "Services", align: "right" },
			],
		},
	},
	{
		id: "table-root-errors",
		name: "Root Errors by Type",
		description: "Error types on root spans only",
		visualization: "table",
		dataSource: {
			endpoint: "errors_by_type",
			params: { limit: 5, rootOnly: true },
			transform: { limit: 5 },
		},
		display: {
			title: "Root Errors by Type",
			columns: [
				{ field: "errorType", header: "Error Type" },
				{ field: "count", header: "Count", unit: "number", align: "right" },
				{ field: "affectedServicesCount", header: "Services", align: "right" },
			],
		},
	},
	{
		id: "table-services",
		name: "Service Overview",
		description: "Services with latency, errors, and throughput",
		visualization: "table",
		dataSource: {
			endpoint: "service_overview",
		},
		display: {
			title: "Service Overview",
			columns: [
				{ field: "serviceName", header: "Service" },
				{ field: "p95LatencyMs", header: "P95", unit: "duration_ms", align: "right" },
				{ field: "errorRate", header: "Error Rate", unit: "percent", align: "right" },
				{ field: "throughput", header: "Throughput", unit: "requests_per_sec", align: "right" },
			],
		},
	},
]
