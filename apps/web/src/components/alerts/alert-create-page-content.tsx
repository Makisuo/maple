import { useSearch } from "@tanstack/react-router"
import { useMemo } from "react"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import type { Dashboard } from "@/components/dashboard-builder/types"

import { AlertCreateFormSurface } from "@/components/alerts/alert-create-form-surface"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import { defaultRuleForm, ruleToFormState, type RuleFormState } from "@/lib/alerts/form-utils"
import { ALERT_TEMPLATES, applyTemplate } from "@/lib/alerts/templates"
import { decodeAlertChartFromSearchParam, type AlertChartContext } from "@/lib/alerts/widget-chart-param"
import {
	createWidgetAlertPrefill,
	resolveWidgetAlertPrefill,
	type WidgetAlertPrefillNotice,
} from "@/lib/alerts/widget-prefill"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useDashboardsRead } from "@/hooks/use-dashboard-store"

type AlertCreateSearchValue = {
	serviceName?: string
	ruleId?: string
	dashboardId?: string
	widgetId?: string
	chart?: string
	template?: string
}

type InitialRuleDraft = {
	key: string
	form: RuleFormState
	prefillNotices: WidgetAlertPrefillNotice[]
	editingRule: AlertRuleDocument | null
	showTemplatesInitially: boolean
}

export function AlertCreatePageContent() {
	const search = useSearch({ from: "/alerts/create" }) as AlertCreateSearchValue

	const chartContext = useMemo(
		() => (search.chart ? decodeAlertChartFromSearchParam(search.chart) : undefined),
		[search.chart],
	)

	// The dashboards list is only needed for the legacy id-lookup fallback —
	// when the navigation carried a decodable widget snapshot, prefill is
	// synchronous and the fetch (plus its loading remount) is skipped entirely.
	const needsDashboards =
		!search.ruleId && chartContext == null && Boolean(search.dashboardId || search.widgetId)

	const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {
		reactivityKeys: ["alertRules"],
	})
	const { result: destinationsResult } = useAlertDestinationsList()
	const rulesResult = useAtomValue(rulesQueryAtom)
	const { dashboards, isLoading: dashboardsLoading, isError: dashboardsError } = useDashboardsRead()
	const dashboardsResult = useMemo(() => {
		if (!needsDashboards || dashboardsLoading) return Result.initial(dashboardsLoading)
		if (dashboardsError) return Result.fail(new Error("Dashboard sync failed"))
		return Result.success({ dashboards })
	}, [needsDashboards, dashboardsLoading, dashboardsError, dashboards])

	const autocompleteValues = useAutocompleteValuesContext()
	const serviceNameOptions = autocompleteValues.traces.services ?? []

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [])

	const initialDraft = useMemo(
		() =>
			deriveInitialRuleDraft({
				search,
				chartContext,
				rulesResult,
				dashboardsResult,
			}),
		[search, chartContext, rulesResult, dashboardsResult],
	)

	return (
		<AlertCreateFormSurface
			key={initialDraft.key}
			initialForm={initialDraft.form}
			prefillNotices={initialDraft.prefillNotices}
			editingRule={initialDraft.editingRule}
			showTemplatesInitially={initialDraft.showTemplatesInitially}
			destinations={destinations}
			serviceNameOptions={serviceNameOptions}
			autocompleteValues={autocompleteValues}
		/>
	)
}

export function deriveInitialRuleDraft({
	search,
	chartContext,
	rulesResult,
	dashboardsResult,
}: {
	search: AlertCreateSearchValue
	chartContext: AlertChartContext | undefined
	rulesResult: Result.Result<{ rules: readonly AlertRuleDocument[] }, unknown>
	dashboardsResult: Result.Result<
		{
			dashboards: readonly Dashboard[]
		},
		unknown
	>
}): InitialRuleDraft {
	const base = defaultRuleForm(search.serviceName)

	if (search.ruleId) {
		if (Result.isSuccess(rulesResult)) {
			const editingRule = rulesResult.value.rules.find((rule) => rule.id === search.ruleId) ?? null
			if (editingRule) {
				return {
					key: `rule:${editingRule.id}`,
					form: ruleToFormState(editingRule),
					prefillNotices: [],
					editingRule,
					showTemplatesInitially: false,
				}
			}
			return {
				key: `missing-rule:${search.ruleId}`,
				form: base,
				prefillNotices: [
					{
						severity: "warning",
						message: "The alert rule could not be found. Starting from a blank alert.",
					},
				],
				editingRule: null,
				showTemplatesInitially: false,
			}
		}
		return {
			key: `loading-rule:${search.ruleId}`,
			form: base,
			prefillNotices: [],
			editingRule: null,
			showTemplatesInitially: false,
		}
	}

	// Snapshot carried through navigation — synchronous prefill, no dashboards
	// fetch, immune to the autosave race. Garbage/oversized params decode to
	// undefined and fall through to the id-lookup path below.
	if (chartContext) {
		const result = createWidgetAlertPrefill(chartContext.widget, base)
		return {
			key: `chart:${chartContext.dashboardId}:${chartContext.widget.id}`,
			form: result.form,
			prefillNotices: result.notices,
			editingRule: null,
			showTemplatesInitially: false,
		}
	}

	if (search.dashboardId || search.widgetId) {
		if (!search.dashboardId || !search.widgetId) {
			const result = resolveWidgetAlertPrefill({
				dashboards: [],
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return {
				key: `missing-chart-source:${search.dashboardId ?? "dashboard"}:${search.widgetId ?? "widget"}`,
				form: result.form,
				prefillNotices: result.notices,
				editingRule: null,
				showTemplatesInitially: false,
			}
		}
		if (Result.isSuccess(dashboardsResult)) {
			const result = resolveWidgetAlertPrefill({
				dashboards: dashboardsResult.value.dashboards,
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return {
				key: `dashboard:${search.dashboardId}:widget:${search.widgetId}`,
				form: result.form,
				prefillNotices: result.notices,
				editingRule: null,
				showTemplatesInitially: false,
			}
		}
		if (Result.isFailure(dashboardsResult)) {
			return {
				key: `dashboard-load-failed:${search.dashboardId}:${search.widgetId}`,
				form: base,
				prefillNotices: [
					{
						severity: "warning",
						message: "Dashboards could not be loaded. Starting from a blank alert.",
					},
				],
				editingRule: null,
				showTemplatesInitially: false,
			}
		}
		return {
			key: `loading-dashboard:${search.dashboardId}:${search.widgetId}`,
			form: base,
			prefillNotices: [],
			editingRule: null,
			showTemplatesInitially: false,
		}
	}

	// Starter-template deep link from the overview empty state — pre-apply the
	// preset and skip the first-touch overlay. An unknown id falls through to the
	// blank draft below (overlay still opens).
	if (search.template) {
		const template = ALERT_TEMPLATES.find((t) => t.id === search.template)
		if (template) {
			return {
				key: `new:template:${template.id}`,
				form: applyTemplate(template, base),
				prefillNotices: [],
				editingRule: null,
				showTemplatesInitially: false,
			}
		}
	}

	return {
		key: `new:${search.serviceName ?? "blank"}`,
		form: base,
		prefillNotices: [],
		editingRule: null,
		showTemplatesInitially: search.serviceName == null,
	}
}
