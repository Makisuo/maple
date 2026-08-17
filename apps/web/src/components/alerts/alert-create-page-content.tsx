import { useSearch } from "@tanstack/react-router"
import { Cause } from "effect"
import { useMemo, type ReactNode } from "react"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import type { Dashboard } from "@/components/dashboard-builder/types"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { AlertCreateFormSurface } from "@/components/alerts/alert-create-form-surface"
import { ErrorState } from "@/components/common/error-state"
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

/**
 * Everything the form surface needs to mount. `key` is its remount identity:
 * equal inputs must derive an equal key (a re-render keeps in-progress edits),
 * and a different rule/prefill source must derive a different one (the surface
 * remounts instead of carrying the previous rule's draft over).
 */
export type RuleDraft = {
	key: string
	form: RuleFormState
	prefillNotices: WidgetAlertPrefillNotice[]
	editingRule: AlertRuleDocument | null
	showTemplatesInitially: boolean
}

/**
 * The page's initialization, as a closed union.
 *
 * The editable draft exists **only** in `ready`, which makes the old failure
 * mode unrepresentable: a blank `defaultRuleForm` used to be built eagerly and
 * carried alongside a `loading` flag, so a terminal list failure — which is not
 * loading and not success — fell through to the loading branch and painted a
 * skeleton that never resolved. `loading` and `failed` are now distinct
 * variants with no form attached to either.
 */
export type RuleInitialization =
	| { readonly status: "loading"; readonly editing: boolean }
	| { readonly status: "failed"; readonly editing: boolean; readonly error: unknown }
	| { readonly status: "ready"; readonly draft: RuleDraft }

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

	const initialization = useMemo(
		() =>
			deriveRuleInitialization({
				search,
				chartContext,
				rulesResult,
				dashboardsResult,
			}),
		[search, chartContext, rulesResult, dashboardsResult],
	)

	switch (initialization.status) {
		// Showing the blank default form here would paint a "Create alert rule"
		// page for a second and then remount into the populated editor.
		case "loading":
			return <AlertRuleFormSkeleton editing={initialization.editing} />
		case "failed":
			return <AlertRuleFormLoadError editing={initialization.editing} error={initialization.error} />
		case "ready":
			return (
				<AlertCreateFormSurface
					key={initialization.draft.key}
					initialForm={initialization.draft.form}
					prefillNotices={initialization.draft.prefillNotices}
					editingRule={initialization.draft.editingRule}
					showTemplatesInitially={initialization.draft.showTemplatesInitially}
					destinations={destinations}
					serviceNameOptions={serviceNameOptions}
					environmentOptions={environmentOptions}
					autocompleteValues={autocompleteValues}
				/>
			)
	}
}

/**
 * The page chrome the form surface itself draws — same breadcrumb, same title,
 * same scroll frame — so the pre-form variants resolve into a page that is
 * already the right shape.
 */
function AlertRuleFormShell({ editing, children }: { editing: boolean; children: ReactNode }) {
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
					<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/** Placeholder shown while an existing rule (or a dashboard widget's prefill source) loads. */
function AlertRuleFormSkeleton({ editing }: { editing: boolean }) {
	return (
		<AlertRuleFormShell editing={editing}>
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
		</AlertRuleFormShell>
	)
}

/**
 * Terminal counterpart to the skeleton: the rules stream stopped, so which rule
 * is being edited can never be answered. Falling back to a blank form would
 * silently turn an edit into a create, so the page stops here instead.
 *
 * Matches the alerts overview's own load error, down to the reload action — the
 * list hooks' `refresh` is a no-op over a live query whose recovery budget is
 * already spent, so a reload is the only honest retry.
 */
function AlertRuleFormLoadError({ editing, error }: { editing: boolean; error: unknown }) {
	return (
		<AlertRuleFormShell editing={editing}>
			<div className={cn("mx-auto w-full", RULE_FORM_MAX_WIDTH)}>
				<ErrorState
					error={error}
					title="Failed to load alert rules"
					onRetry={() => window.location.reload()}
					className="py-12"
				/>
			</div>
		</AlertRuleFormShell>
	)
}

const ready = (draft: RuleDraft): RuleInitialization => ({ status: "ready", draft })

export function deriveRuleInitialization({
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
}): RuleInitialization {
	const base = defaultRuleForm(search.serviceName)

	if (search.ruleId) {
		// Terminal: the stream is gone, so "which rule is this?" has no answer
		// coming. Checked before success/loading so it can never be mistaken for
		// the pending state.
		if (Result.isFailure(rulesResult)) {
			return { status: "failed", editing: true, error: Cause.squash(rulesResult.cause) }
		}
		if (Result.isSuccess(rulesResult)) {
			const editingRule = rulesResult.value.rules.find((rule) => rule.id === search.ruleId) ?? null
			if (editingRule) {
				return ready({
					key: `rule:${editingRule.id}`,
					form: ruleToFormState(editingRule),
					prefillNotices: [],
					editingRule,
					showTemplatesInitially: false,
				})
			}
			// Resolved, but no such rule — distinct from both "still loading" and
			// "could not load": the list is authoritative, so a blank draft plus an
			// explicit notice is the right recovery.
			return ready({
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
			})
		}
		return { status: "loading", editing: true }
	}

	// Snapshot carried through navigation — synchronous prefill, no dashboards
	// fetch, immune to the autosave race. Garbage/oversized params decode to
	// undefined and fall through to the id-lookup path below.
	if (chartContext) {
		const result = createWidgetAlertPrefill(chartContext.widget, base)
		return ready({
			key: `chart:${chartContext.dashboardId}:${chartContext.widget.id}`,
			form: result.form,
			prefillNotices: result.notices,
			editingRule: null,
			showTemplatesInitially: false,
		})
	}

	if (search.dashboardId || search.widgetId) {
		if (!search.dashboardId || !search.widgetId) {
			const result = resolveWidgetAlertPrefill({
				dashboards: [],
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return ready({
				key: `missing-chart-source:${search.dashboardId ?? "dashboard"}:${search.widgetId ?? "widget"}`,
				form: result.form,
				prefillNotices: result.notices,
				editingRule: null,
				showTemplatesInitially: false,
			})
		}
		if (Result.isSuccess(dashboardsResult)) {
			const result = resolveWidgetAlertPrefill({
				dashboards: dashboardsResult.value.dashboards,
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return ready({
				key: `dashboard:${search.dashboardId}:widget:${search.widgetId}`,
				form: result.form,
				prefillNotices: result.notices,
				editingRule: null,
				showTemplatesInitially: false,
			})
		}
		if (Result.isFailure(dashboardsResult)) {
			// Deliberately `ready`, not `failed`: without a ruleId nothing is being
			// edited, so a blank draft plus a notice is a usable page rather than a
			// dead end.
			return ready({
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
			})
		}
		return { status: "loading", editing: false }
	}

	// Starter-template deep link from the overview empty state — pre-apply the
	// preset and skip the first-touch overlay. An unknown id falls through to the
	// blank draft below (overlay still opens).
	if (search.template) {
		const template = ALERT_TEMPLATES.find((t) => t.id === search.template)
		if (template) {
			return ready({
				key: `new:template:${template.id}`,
				form: applyTemplate(template, base),
				prefillNotices: [],
				editingRule: null,
				showTemplatesInitially: false,
			})
		}
	}

	return ready({
		key: `new:${search.serviceName ?? "blank"}`,
		form: base,
		prefillNotices: [],
		editingRule: null,
		showTemplatesInitially: search.serviceName == null,
	})
}
