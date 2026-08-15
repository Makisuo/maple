import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"

import { normalizeRuleQueryDraft, rawSqlHasValueColumn, type RuleFormState } from "@/lib/alerts/form-utils"
import { buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import { SERIES_REDUCER_TO_ALERT_REDUCER, toQueryBuilderDataSource } from "@maple/query-model"
import { dataSourceQuerySet, dataSourceRawSql, dataSourceTransform } from "@maple/widgets/dashboard"

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

function record(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function widgetAlertName(widget: AlertableDashboardWidget): string {
	return widget.display?.title ? `Alert - ${widget.display.title}` : "Alert from chart"
}

function isQueryDraftPayload(value: unknown): value is QueryBuilderQueryDraftPayload {
	const query = record(value)
	return toQueryBuilderDataSource(query.dataSource) !== null && typeof query.aggregation === "string"
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
	const hideSeries = record(dataSourceTransform(widget.dataSource)?.hideSeries)
	return Array.isArray(hideSeries.baseNames) && hideSeries.baseNames.length > 0
}

function comparisonEnabled(comparison: unknown): boolean {
	const mode = record(comparison).mode
	return typeof mode === "string" && mode !== "none"
}

function queryToForm(
	base: RuleFormState,
	widget: AlertableDashboardWidget,
	query: QueryBuilderQueryDraftPayload,
): RuleFormState {
	const queryBuilderDraft = normalizeRuleQueryDraft(query)
	return {
		...base,
		name: widgetAlertName(widget),
		signalType: "builder_query",
		queryBuilderDraft,
		// Builder thresholds compare against the query's raw output. error_rate
		// is a 0–1 ratio, so the blank-form default of "5" (tuned for the
		// percent-entry error_rate signal) would mean a 500% error rate.
		threshold: query.aggregation === "error_rate" ? "0.05" : base.threshold,
		groupBy: [],
	}
}

export function createWidgetAlertPrefill(
	widget: AlertableDashboardWidget,
	base: RuleFormState,
): WidgetAlertPrefillResult {
	// Structural, not endpoint-string: this is the "create an alert from this
	// chart" path, and it has to keep reading a widget once the stored data
	// source flips to the typed v3 union.
	const rawSql = dataSourceRawSql(widget.dataSource)
	const querySet = dataSourceQuerySet(widget.dataSource)
	const notices: WidgetAlertPrefillNotice[] = []

	if (rawSql !== null) {
		const sql = rawSql.sql
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

		// The chart's own reducer, not the blank form's `identity`. A stat tile
		// showing max(latency) produced an alert that evaluated the last bucket,
		// silently and with nothing on screen to say so.
		const chartReducer = dataSourceTransform(widget.dataSource)?.reduceToValue?.aggregate
		const rawQueryReducer =
			chartReducer === undefined ? undefined : SERIES_REDUCER_TO_ALERT_REDUCER[chartReducer]
		if (chartReducer !== undefined && rawQueryReducer === undefined) {
			notices.push({
				severity: "warning",
				message: `This chart reduces its series with "${chartReducer}", which alert rules cannot express; the alert evaluates the window's last value instead.`,
			})
		}

		return {
			form: {
				...base,
				name: widgetAlertName(widget),
				signalType: "raw_query",
				rawQuerySql: sql,
				...(!(rawQueryReducer === undefined) ? { rawQueryReducer } : undefined),
			},
			notices,
		}
	}

	if (querySet !== null) {
		const queries = querySet.queries.filter(isQueryDraftPayload)
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
		const formulas = querySet.formulas ?? []
		if (formulas.length > 0) {
			notices.push({
				severity: "warning",
				message:
					"Chart formulas are not represented in alert rules yet; the alert uses the selected base query.",
			})
		}
		if (comparisonEnabled(querySet.comparison)) {
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
		const built = buildTimeseriesQuerySpec(form.queryBuilderDraft)
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
