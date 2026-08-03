import { useSearch } from "@tanstack/react-router"
import { useMemo } from "react"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import type { Dashboard } from "@/components/dashboard-builder/types"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { AlertCreateFormSurface } from "@/components/alerts/alert-create-form-surface"
import { RULE_FORM_MAX_WIDTH } from "@/components/alerts/rule-form-layout"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import { defaultRuleForm, ruleToFormState, type RuleFormState } from "@/lib/alerts/form-utils"
import { ALERT_TEMPLATES, applyTemplate } from "@/lib/alerts/templates"
import { decodeAlertChartFromSearchParam, type AlertChartContext } from "@/lib/alerts/widget-chart-param"
import {
	createWidgetAlertPrefill,
	resolveWidgetAlertPrefill,
	type WidgetAlertPrefillNotice,
} from "@/lib/alerts/widget-prefill"
import { useAlertDestinationsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { Result } from "@/lib/effect-atom"
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
	/**
	 * The draft is a placeholder while the real rule (or its dashboard source) is
	 * still loading. The form must not be shown yet — `form` is a blank default
	 * that would read as "Create alert rule" until the fetch resolves and the
	 * `key` change remounts it with the actual values.
	 */
	loading?: boolean
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

	const { result: destinationsResult } = useAlertDestinationsList()
	const { result: rulesResult } = useAlertRulesList()
	const { dashboards, isLoading: dashboardsLoading, isError: dashboardsError } = useDashboardsRead()
	const dashboardsResult = useMemo(() => {
		if (!needsDashboards || dashboardsLoading) return Result.initial(dashboardsLoading)
		if (dashboardsError) return Result.fail(new Error("Dashboard sync failed"))
		return Result.success({ dashboards })
	}, [needsDashboards, dashboardsLoading, dashboardsError, dashboards])

	const autocompleteValues = useAutocompleteValuesContext()
	const serviceNameOptions = autocompleteValues.traces.services ?? []
	// Sourced from the traces `deploymentEnv` facet the provider already fetches —
	// the scope picker costs no extra round-trip.
	const environmentOptions = autocompleteValues.traces.environments ?? []

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

	// Showing the blank default form here would paint a "Create alert rule" page
	// for a second and then remount into the populated editor.
	if (initialDraft.loading) {
		return <AlertRuleFormSkeleton editing={search.ruleId != null} />
	}

	return (
		<AlertCreateFormSurface
			key={initialDraft.key}
			initialForm={initialDraft.form}
			prefillNotices={initialDraft.prefillNotices}
			editingRule={initialDraft.editingRule}
			showTemplatesInitially={initialDraft.showTemplatesInitially}
			destinations={destinations}
			serviceNameOptions={serviceNameOptions}
			environmentOptions={environmentOptions}
			autocompleteValues={autocompleteValues}
		/>
	)
}

/**
 * Placeholder shown while an existing rule (or a dashboard widget's prefill
 * source) loads. Mirrors the real surface's chrome — same breadcrumb, same
 * title, same two-column grid — so resolving the fetch swaps content into a
 * page that is already the right shape.
 */
function AlertRuleFormSkeleton({ editing }: { editing: boolean }) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Alerts", href: "/alerts" }, { label: editing ? "Edit Rule" : "New Rule" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={editing ? "Edit alert rule" : "Create alert rule"} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className={cn("mx-auto w-full space-y-4", RULE_FORM_MAX_WIDTH)}>
							<Skeleton className="h-64 w-full" />
							<div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
								<Skeleton className="h-96 w-full" />
								<div className="space-y-4">
									<Skeleton className="h-56 w-full" />
									<Skeleton className="h-40 w-full" />
									<Skeleton className="h-48 w-full" />
								</div>
							</div>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
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
			loading: true,
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
			loading: true,
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
