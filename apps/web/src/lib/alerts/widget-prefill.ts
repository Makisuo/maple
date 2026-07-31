import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"

import { buildQueryDraftFromForm, rawSqlHasValueColumn, type RuleFormState } from "@/lib/alerts/form-utils"
import { buildTimeseriesQuerySpec } from "@/lib/query-builder/model"

export type WidgetAlertPrefillNotice = {
	severity: "warning" | "error"
	message: string
}

export type WidgetAlertPrefillResult = {
	form: RuleFormState
	notices: WidgetAlertPrefillNotice[]
}

type AlertableDashboardWidget = {
	id: string
	visualization?: string
	dataSource?: {
		endpoint?: string
		params?: unknown
		transform?: unknown
	}
	display?: { title?: string }
}

type DashboardWithWidgets = {
	id: string
	widgets: readonly AlertableDashboardWidget[]
}

const QUERY_BUILDER_ENDPOINTS = new Set([
	"custom_query_builder_timeseries",
	"custom_query_builder_breakdown",
	"custom_query_builder_list",
])

function record(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function widgetAlertName(widget: AlertableDashboardWidget): string {
	return widget.display?.title ? `Alert - ${widget.display.title}` : "Alert from chart"
}

function isQueryDraftPayload(value: unknown): value is QueryBuilderQueryDraftPayload {
	const query = record(value)
	const dataSource = query.dataSource
	return (
		(dataSource === "traces" || dataSource === "logs" || dataSource === "metrics") &&
		typeof query.aggregation === "string"
	)
}

function isEnabledVisibleQuery(query: QueryBuilderQueryDraftPayload): boolean {
	return query.enabled !== false && query.hidden !== true
}

function queryLabel(query: QueryBuilderQueryDraftPayload, index: number): string {
	if (typeof query.legend === "string" && query.legend.trim().length > 0) {
		return query.legend.trim()
	}
	if (typeof query.name === "string" && query.name.trim().length > 0) {
		return query.name.trim()
	}
	return `query ${index + 1}`
}

function hasHiddenSeries(
	widget: AlertableDashboardWidget,
	queries: QueryBuilderQueryDraftPayload[],
): boolean {
	if (queries.some((query) => query.hidden === true)) return true
	const transform = record(widget.dataSource?.transform)
	const hideSeries = record(transform.hideSeries)
	return Array.isArray(hideSeries.baseNames) && hideSeries.baseNames.length > 0
}

function comparisonEnabled(params: Record<string, unknown>): boolean {
	const comparison = record(params.comparison)
	return typeof comparison.mode === "string" && comparison.mode !== "none"
}

function queryToForm(
	base: RuleFormState,
	widget: AlertableDashboardWidget,
	query: QueryBuilderQueryDraftPayload,
): RuleFormState {
	return {
		...base,
		name: widgetAlertName(widget),
		signalType: "builder_query",
		queryBuilderDraft: query,
		queryDataSource: query.dataSource,
		queryAggregation: query.aggregation,
		queryWhereClause: query.whereClause ?? "",
		// Builder thresholds compare against the query's raw output. error_rate
		// is a 0–1 ratio, so the blank-form default of "5" (tuned for the
		// percent-entry error_rate signal) would mean a 500% error rate.
		threshold: query.aggregation === "error_rate" ? "0.05" : base.threshold,
		groupBy: [],
		metricName: query.dataSource === "metrics" ? (query.metricName ?? "") : base.metricName,
		metricType:
			query.dataSource === "metrics" && query.metricType != null ? query.metricType : base.metricType,
	}
}

export function createWidgetAlertPrefill(
	widget: AlertableDashboardWidget,
	base: RuleFormState,
): WidgetAlertPrefillResult {
	const endpoint = widget.dataSource?.endpoint
	const params = record(widget.dataSource?.params)
	const notices: WidgetAlertPrefillNotice[] = []

	if (endpoint === "raw_sql_chart") {
		const sql = typeof params.sql === "string" ? params.sql : ""
		if (sql.trim().length === 0) {
			notices.push({
				severity: "warning",
				message: "This raw SQL chart has no SQL saved. Starting with an editable blank alert query.",
			})
		} else {
			if (!sql.includes("$__orgFilter")) {
				notices.push({
					severity: "warning",
					message:
						"Copied chart SQL is missing $__orgFilter; alerts require org-scoped SQL before saving.",
				})
			}
			if (!rawSqlHasValueColumn(sql)) {
				notices.push({
					severity: "warning",
					message:
						"Copied chart SQL does not clearly return a numeric value column. Alias the alert value as value before saving.",
				})
			}
		}

		return {
			form: {
				...base,
				name: widgetAlertName(widget),
				signalType: "raw_query",
				rawQuerySql: sql,
			},
			notices,
		}
	}

	if (endpoint != null && QUERY_BUILDER_ENDPOINTS.has(endpoint)) {
		const queries = Array.isArray(params.queries) ? params.queries.filter(isQueryDraftPayload) : []
		const selectedIndex = queries.findIndex(isEnabledVisibleQuery)
		const selected =
			selectedIndex >= 0
				? queries[selectedIndex]
				: (queries.find((query) => query.enabled !== false) ?? queries[0])

		if (!selected) {
			return {
				form: base,
				notices: [
					{
						severity: "warning",
						message:
							"This chart has no alert-compatible query saved. Starting from a blank alert.",
					},
				],
			}
		}

		const visibleEnabledCount = queries.filter(isEnabledVisibleQuery).length
		if (visibleEnabledCount > 1) {
			notices.push({
				severity: "warning",
				message: `This chart has ${visibleEnabledCount} visible queries; the alert uses ${queryLabel(selected, selectedIndex)} only.`,
			})
		}
		const formulas = Array.isArray(params.formulas) ? params.formulas : []
		if (formulas.length > 0) {
			notices.push({
				severity: "warning",
				message:
					"Chart formulas are not represented in alert rules yet; the alert uses the selected base query.",
			})
		}
		if (comparisonEnabled(params)) {
			notices.push({
				severity: "warning",
				message:
					"Chart comparison data is not represented in alert rules; the alert evaluates the current window only.",
			})
		}
		if (hasHiddenSeries(widget, queries)) {
			notices.push({
				severity: "warning",
				message:
					"Hidden chart series are not preserved in alert rules. Review the alert grouping before saving.",
			})
		}

		const form = queryToForm(base, widget, selected)
		const built = buildTimeseriesQuerySpec(buildQueryDraftFromForm(form))
		if (built.error != null || built.query == null) {
			notices.push({
				severity: "warning",
				message: `Selected chart query is not alert-ready: ${built.error ?? "failed to build query"}.`,
			})
		}
		for (const warning of built.warnings) {
			notices.push({
				severity: "warning",
				message: `Selected chart query warning: ${warning}.`,
			})
		}

		return { form, notices }
	}

	return {
		form: base,
		notices: [
			{
				severity: "warning",
				message: "This widget is not a query-driven chart. Starting from a blank alert.",
			},
		],
	}
}

export function resolveWidgetAlertPrefill({
	dashboards,
	dashboardId,
	widgetId,
	base,
}: {
	dashboards: readonly DashboardWithWidgets[]
	dashboardId?: string
	widgetId?: string
	base: RuleFormState
}): WidgetAlertPrefillResult {
	if (!dashboardId) {
		return {
			form: base,
			notices: [
				{
					severity: "warning",
					message: "The source dashboard id was missing. Starting from a blank alert.",
				},
			],
		}
	}
	if (!widgetId) {
		return {
			form: base,
			notices: [
				{
					severity: "warning",
					message: "The source chart id was missing. Starting from a blank alert.",
				},
			],
		}
	}

	const dashboard = dashboards.find((candidate) => candidate.id === dashboardId)
	if (!dashboard) {
		return {
			form: base,
			notices: [
				{
					severity: "warning",
					message: "The source dashboard could not be found. Starting from a blank alert.",
				},
			],
		}
	}

	const widget = dashboard.widgets.find((candidate) => candidate.id === widgetId)
	if (!widget) {
		return {
			form: base,
			notices: [
				{
					severity: "warning",
					message: "The source chart could not be found. Starting from a blank alert.",
				},
			],
		}
	}

	return createWidgetAlertPrefill(widget, base)
}
