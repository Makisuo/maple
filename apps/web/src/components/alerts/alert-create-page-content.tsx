import { useSearch } from "@tanstack/react-router"
import { useMemo } from "react"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"

import { AlertCreateFormSurface } from "@/components/alerts/alert-create-form-surface"
import { RULE_FORM_MAX_WIDTH } from "@/components/alerts/rule-form-layout"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import { defaultRuleForm, ruleToFormState, type RuleFormState } from "@/lib/alerts/form-utils"
import { ALERT_TEMPLATES, applyTemplate } from "@/lib/alerts/templates"
import { decodeAlertChartFromSearchParam, type AlertChartContext } from "@/lib/alerts/widget-chart-param"
import { createWidgetAlertPrefill, type WidgetAlertPrefillNotice } from "@/lib/alerts/widget-prefill"
import { useAlertDestinationsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { Result } from "@/lib/effect-atom"

type AlertCreateSearchValue = {
	serviceName?: string
	ruleId?: string
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
	 * The draft is a placeholder while the real rule is loading. The form must
	 * not be shown yet — `form` is a blank default that would read as "Create
	 * alert rule" until the fetch resolves and the `key` change remounts it.
	 */
	loading?: boolean
}

export function AlertCreatePageContent() {
	const search = useSearch({ from: "/alerts/create" }) as AlertCreateSearchValue

	const chartContext = useMemo(
		() => (search.chart ? decodeAlertChartFromSearchParam(search.chart) : undefined),
		[search.chart],
	)

	const { result: destinationsResult } = useAlertDestinationsList()
	const { result: rulesResult } = useAlertRulesList()

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
			}),
		[search, chartContext, rulesResult],
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
 * Placeholder shown while an existing rule loads. Mirrors the real surface's
 * chrome — same breadcrumb, same title, same two-column grid — so resolving the
 * fetch swaps content into a page that is already the right shape.
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
}: {
	search: AlertCreateSearchValue
	chartContext: AlertChartContext | undefined
	rulesResult: Result.Result<{ rules: readonly AlertRuleDocument[] }, unknown>
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

	// Snapshot carried through navigation: synchronous and immune to the
	// dashboard autosave race.
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

	if (search.chart) {
		return {
			key: "invalid-chart-snapshot",
			form: base,
			prefillNotices: [
				{
					severity: "warning",
					message: "The source chart snapshot was invalid. Starting from a blank alert.",
				},
			],
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
