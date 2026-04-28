import { Schema } from "effect"
import {
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	PortableDashboardDocument,
} from "@maple/domain/http"
import type { TemplateParameterValues, WidgetDef } from "./types"

// ---------------------------------------------------------------------------
// Brand makers — used inside template definitions for compile-time correctness
// ---------------------------------------------------------------------------

export const templateId = (value: string): DashboardTemplateId =>
	Schema.decodeUnknownSync(DashboardTemplateId)(value)

export const paramKey = (value: string): DashboardTemplateParameterKey =>
	Schema.decodeUnknownSync(DashboardTemplateParameterKey)(value)

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

// ---------------------------------------------------------------------------
// Query draft helpers — produce the queries format expected by the
// custom_query_builder_timeseries / custom_query_builder_breakdown endpoints
// ---------------------------------------------------------------------------

export function makeQueryDraft(opts: {
	id: string
	name: string
	dataSource: "traces" | "logs" | "metrics"
	aggregation: string
	whereClause?: string
	groupBy?: string[]
	metricName?: string
	metricType?: string
	isMonotonic?: boolean
}): Record<string, unknown> {
	return {
		id: opts.id,
		name: opts.name,
		enabled: true,
		dataSource: opts.dataSource,
		signalSource: "default",
		metricName: opts.metricName ?? "",
		metricType: opts.metricType ?? "sum",
		...(opts.isMonotonic != null && { isMonotonic: opts.isMonotonic }),
		whereClause: opts.whereClause ?? "",
		aggregation: opts.aggregation,
		stepInterval: "",
		orderByDirection: "desc",
		addOns: {
			groupBy: (opts.groupBy?.length ?? 0) > 0,
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
		},
		groupBy: opts.groupBy ?? [],
		having: "",
		orderBy: "",
		limit: "",
		legend: "",
	}
}

export function makeQueryBuilderTimeseriesDataSource(queries: Record<string, unknown>[]): {
	endpoint: string
	params: Record<string, unknown>
} {
	return {
		endpoint: "custom_query_builder_timeseries",
		params: {
			queries,
			formulas: [],
			comparison: { mode: "none", includePercentChange: true },
			debug: false,
		},
	}
}

export function makeQueryBuilderBreakdownDataSource(queries: Record<string, unknown>[]): {
	endpoint: string
	params: Record<string, unknown>
} {
	return {
		endpoint: "custom_query_builder_breakdown",
		params: { queries },
	}
}

// ---------------------------------------------------------------------------
// Chart display presets
// ---------------------------------------------------------------------------

export const CHART_DISPLAY_AREA = {
	chartId: "query-builder-area",
	chartPresentation: { legend: "visible" },
	stacked: true,
	curveType: "monotone",
}

export const CHART_DISPLAY_LINE = {
	chartId: "query-builder-line",
	chartPresentation: { legend: "visible" },
	stacked: false,
	curveType: "monotone",
}

export const CHART_DISPLAY_BAR = {
	chartId: "query-builder-bar",
	chartPresentation: { legend: "visible" },
	stacked: true,
	curveType: "linear",
}

export function chartDisplayForMetric(aggregation: string): Record<string, unknown> {
	if (["count", "error_rate", "rate", "increase"].includes(aggregation)) {
		return CHART_DISPLAY_AREA
	}
	if (
		["avg_duration", "p50_duration", "p95_duration", "p99_duration", "avg", "max", "min"].includes(
			aggregation,
		)
	) {
		return CHART_DISPLAY_LINE
	}
	return CHART_DISPLAY_BAR
}

// ---------------------------------------------------------------------------
// Where clause helpers
// ---------------------------------------------------------------------------

export function serviceWhereClause(serviceName?: string): string {
	return serviceName ? `service.name = "${serviceName}"` : ""
}

export function combineWhere(...clauses: Array<string | undefined>): string {
	return clauses.filter((clause) => clause && clause.trim().length > 0).join(" AND ")
}

export function attrEqClause(attr: string, value?: string): string {
	if (!value) return ""
	return `${attr} = "${value}"`
}

// ---------------------------------------------------------------------------
// Metrics chart helpers
// ---------------------------------------------------------------------------

export function metricsTimeseries(opts: {
	id: string
	name: string
	metricName: string
	metricType: string
	aggregation?: string
	whereClause?: string
	groupBy?: string[]
	isMonotonic?: boolean
}): { endpoint: string; params: Record<string, unknown> } {
	return makeQueryBuilderTimeseriesDataSource([
		makeQueryDraft({
			id: opts.id,
			name: opts.name,
			dataSource: "metrics",
			aggregation: opts.aggregation ?? "avg",
			whereClause: opts.whereClause ?? "",
			groupBy: opts.groupBy ?? [],
			metricName: opts.metricName,
			metricType: opts.metricType,
			isMonotonic: opts.isMonotonic,
		}),
	])
}

export function metricsBreakdown(opts: {
	id: string
	name: string
	metricName: string
	metricType: string
	aggregation?: string
	whereClause?: string
	groupBy: string[]
}): { endpoint: string; params: Record<string, unknown> } {
	return makeQueryBuilderBreakdownDataSource([
		makeQueryDraft({
			id: opts.id,
			name: opts.name,
			dataSource: "metrics",
			aggregation: opts.aggregation ?? "avg",
			whereClause: opts.whereClause ?? "",
			groupBy: opts.groupBy,
			metricName: opts.metricName,
			metricType: opts.metricType,
		}),
	])
}

// ---------------------------------------------------------------------------
// Build PortableDashboardDocument from a template's widget list
// ---------------------------------------------------------------------------

export function buildPortableDashboard(opts: {
	name: string
	description?: string
	tags?: readonly string[]
	timeRange?: string
	widgets: WidgetDef[]
}): PortableDashboardDocument {
	return decodePortableDashboard({
		name: opts.name,
		...(opts.description && { description: opts.description }),
		...(opts.tags && opts.tags.length > 0 && { tags: opts.tags }),
		timeRange: { type: "relative", value: opts.timeRange ?? "1h" },
		widgets: opts.widgets,
	})
}

export function paramValue(values: TemplateParameterValues, key: string): string | undefined {
	return values[paramKey(key)]
}
