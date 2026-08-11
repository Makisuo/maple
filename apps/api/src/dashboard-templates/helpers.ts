import { Schema } from "effect"
import {
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	PortableDashboardDocument,
} from "@maple/domain/http"
import type { TemplateParameterValues, WidgetDef } from "./types"

// Brand makers — used inside template definitions for compile-time correctness

export const templateId = (value: string): DashboardTemplateId =>
	Schema.decodeSync(DashboardTemplateId)(value)

export const paramKey = (value: string): DashboardTemplateParameterKey =>
	Schema.decodeSync(DashboardTemplateParameterKey)(value)

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

// Query draft helpers — produce the queries format expected by the
// custom_query_builder_timeseries / custom_query_builder_breakdown endpoints

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
	const draft: Record<string, unknown> = {
		id: opts.id,
		name: opts.name,
		enabled: true,
		dataSource: opts.dataSource,
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
	// Metric-only fields belong solely to the metrics source.
	if (opts.dataSource === "metrics") {
		draft.signalSource = "default"
		draft.metricName = opts.metricName ?? ""
		draft.metricType = opts.metricType ?? "gauge"
		draft.isMonotonic = opts.isMonotonic ?? false
	}
	return draft
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

// `seriesStats` (the Min/Max/Mean/Last table) is opt-in and costs up to 45% of a
// widget's height. Every preset states it outright rather than leaning on the
// default, so an exported dashboard renders the same wherever it is imported.
// It earns that space only where the answer is a number: line charts here are
// levels (heap, latency, lag, utilization). Area and bar are stacked rates and
// breakdowns read for shape and composition, where per-series stats under a
// cumulative plot duplicate the tooltip at best and mislead at worst (`Last` of a
// bucketed rate is the partial trailing bucket) — those get the compact legend.
// `showPoints` is likewise stated rather than defaulted. Templates chart whole
// fleets, so a single series with an isolated spike would otherwise trip the
// sparse-data heuristic and stipple every dense series in the same chart with
// point markers. Hovering still gives the active dot, and a reader who wants
// permanent points can turn them back on per widget.
export const CHART_DISPLAY_AREA = {
	chartId: "query-builder-area",
	chartPresentation: { legend: "visible", seriesStats: false, showPoints: false },
	stacked: true,
	curveType: "monotone",
}

export const CHART_DISPLAY_LINE = {
	chartId: "query-builder-line",
	chartPresentation: { legend: "visible", seriesStats: true, showPoints: false },
	stacked: false,
	curveType: "monotone",
}

// Bar is for counted events that are sparse and bursty — restarts, deadlocks,
// evictions, slow queries, dropped messages. A stacked area over those draws a
// continuous ribbon between two isolated incidents and reads as sustained
// pressure; discrete bars read as "three restarts, at these three times".
export const CHART_DISPLAY_BAR = {
	chartId: "query-builder-bar",
	chartPresentation: { legend: "visible", seriesStats: false, showPoints: false },
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

// Escape a user-supplied value before it is interpolated into a double-quoted
// metric where-clause literal, so a value containing `"` (or `\`) can't break
// out of the string. Metric where-clauses are ClickHouse-dialect string literals.
export function escapeMetricStringLiteral(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function serviceWhereClause(serviceName?: string): string {
	return serviceName ? `service.name = "${escapeMetricStringLiteral(serviceName)}"` : ""
}

export function combineWhere(...clauses: Array<string | undefined>): string {
	return clauses.filter((clause) => clause && clause.trim().length > 0).join(" AND ")
}

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
