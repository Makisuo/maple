import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { useMemo, useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/utils"

import { DetailsSection } from "@/components/alerts/details-section"
import { NotificationsSection } from "@/components/alerts/notifications-section"
import { RuleActionBar } from "@/components/alerts/rule-action-bar"
import { RULE_FORM_MAX_WIDTH } from "@/components/alerts/rule-form-layout"
import { RuleLiveChartHero } from "@/components/alerts/rule-live-chart-hero"
import { RuleTemplatesOverlay } from "@/components/alerts/rule-templates-overlay"
import { ScopeSection } from "@/components/alerts/scope-section"
import { SignalAndThresholdSection } from "@/components/alerts/signal-and-threshold-section"
import { WidgetPrefillNoticeBanner } from "@/components/alerts/widget-prefill-notice-banner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAlertRulePreview } from "@/hooks/use-alert-rule-preview"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import {
	buildRuleCreateParamsV2,
	buildRuleTestParamsV2,
	deriveRuleQueryIssues,
	getExitErrorMessage,
	isRangeComparator,
	isRulePreviewReady,
	signalLabels,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { applyTemplate } from "@/lib/alerts/templates"
import type { WidgetAlertPrefillNotice } from "@/lib/alerts/widget-prefill"
import { Result, useAtomSet } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useAlertRulesList } from "@/hooks/use-alerts-list"

export function AlertCreateFormSurface({
	initialForm,
	prefillNotices,
	editingRule,
	showTemplatesInitially,
	destinations,
	serviceNameOptions,
	environmentOptions,
	autocompleteValues,
}: {
	initialForm: RuleFormState
	prefillNotices: WidgetAlertPrefillNotice[]
	editingRule: AlertRuleDocument | null
	showTemplatesInitially: boolean
	destinations: AlertDestinationDocument[]
	serviceNameOptions: string[]
	environmentOptions: string[]
	autocompleteValues: ReturnType<typeof useAutocompleteValuesContext>
}) {
	const navigate = useNavigate({ from: "/alerts/create" })
	const createRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "create"), {
		mode: "promiseExit",
	})
	const updateRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "update"), {
		mode: "promiseExit",
	})
	const testRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "test"), {
		mode: "promiseExit",
	})

	const [ruleForm, setRuleForm] = useState<RuleFormState>(() => initialForm)
	const [savingRule, setSavingRule] = useState(false)
	const [previewingRule, setPreviewingRule] = useState(false)
	const [sendingTestNotification, setSendingTestNotification] = useState(false)
	// Tagged with the rule config it was produced from. A "Would trigger" verdict
	// is only meaningful for the exact signal/threshold/scope that was tested, so
	// editing any of those makes the stored result stale rather than wrong-but-shown.
	// Compared at render time — no effect needed to clear it.
	const [previewResult, setPreviewResult] = useState<{
		key: string
		status: "breached" | "healthy" | "skipped"
		value: number | null
		sampleCount: number
		reason: string
	} | null>(null)

	// First-touch template picker: shown only when this is a fresh new-rule
	// entry with no pre-fills.
	const [templatesOpen, setTemplatesOpen] = useState(() => showTemplatesInitially)

	const { preview, previewLoading, previewError } = useAlertRulePreview(ruleForm)

	const validationIssues = useMemo(
		() => deriveValidationIssues(ruleForm, destinations),
		[ruleForm, destinations],
	)

	const suggestedName = useMemo(() => makeSuggestedName(ruleForm), [ruleForm])

	// Tags already in use across the org's rules, offered as autocomplete so
	// teams converge on a shared vocabulary instead of typo-forking groups.
	const { result: rulesResult } = useAlertRulesList()
	const tagSuggestions = useMemo(
		() =>
			Result.builder(rulesResult)
				.onSuccess((response) => [...new Set(response.rules.flatMap((rule) => rule.tags))].sort())
				.orElse(() => [] as string[]),
		[rulesResult],
	)

	async function handleSave() {
		setSavingRule(true)
		const payload = buildRuleCreateParamsV2(ruleForm)
		const result = editingRule
			? await updateRule({
					params: { id: editingRule.id },
					payload,
					reactivityKeys: ["alertRules"],
				})
			: await createRule({ payload, reactivityKeys: ["alertRules"] })

		if (Exit.isSuccess(result)) {
			toastManager.add({ title: editingRule ? "Rule updated" : "Rule created", type: "success" })
			navigate({ to: "/alerts" })
		} else {
			toastManager.add({ title: getExitErrorMessage(result, "Failed to save rule"), type: "error" })
		}
		setSavingRule(false)
	}

	async function runTest(sendNotification: boolean) {
		if (!isRulePreviewReady(ruleForm)) {
			toastManager.add({
				title: "Complete the rule name, query, and threshold before testing",
				type: "error",
			})
			return
		}
		const setLoading = sendNotification ? setSendingTestNotification : setPreviewingRule
		setLoading(true)
		const testedKey = previewIdentityKey(ruleForm)
		const result = await testRule({
			payload: buildRuleTestParamsV2(ruleForm, sendNotification),
			reactivityKeys: ["alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			setPreviewResult({
				key: testedKey,
				status: result.value.status,
				value: result.value.value,
				sampleCount: result.value.sample_count,
				reason: result.value.reason,
			})
			toastManager.add({
				title: sendNotification ? "Preview ran and sent a test notification" : "Preview updated",
				type: "success",
			})
		} else {
			toastManager.add({ title: getExitErrorMessage(result, "Failed to preview rule"), type: "error" })
		}
		setLoading(false)
	}

	const pageTitle = editingRule ? "Edit alert rule" : "Create alert rule"
	const showScope = ruleForm.signalType !== "builder_query" && ruleForm.signalType !== "raw_query"
	// Drop the verdict as soon as the user edits anything it depended on.
	const currentPreviewKey = previewIdentityKey(ruleForm)
	const freshPreviewResult = previewResult?.key === currentPreviewKey ? previewResult : null

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Alerts", href: "/alerts" },
					{ label: editingRule ? "Edit Rule" : "New Rule" },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={pageTitle} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className={cn("mx-auto w-full space-y-4", RULE_FORM_MAX_WIDTH)}>
							<WidgetPrefillNoticeBanner notices={prefillNotices} />
							<RuleLiveChartHero
								form={ruleForm}
								preview={preview}
								previewLoading={previewLoading}
								previewError={previewError}
								onTestRule={() => runTest(false)}
								testing={previewingRule}
								previewResult={freshPreviewResult}
							/>
							<div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
								<SignalAndThresholdSection
									form={ruleForm}
									onChange={setRuleForm}
									autocompleteValues={autocompleteValues}
								/>
								<div className="space-y-4">
									{showScope && (
										<ScopeSection
											form={ruleForm}
											onChange={setRuleForm}
											serviceNameOptions={serviceNameOptions}
											environmentOptions={environmentOptions}
											autocompleteValues={autocompleteValues}
										/>
									)}
									<NotificationsSection
										form={ruleForm}
										onChange={setRuleForm}
										destinations={destinations}
										onSendTest={() => runTest(true)}
										testing={sendingTestNotification}
									/>
									<DetailsSection
										form={ruleForm}
										onChange={setRuleForm}
										suggestedName={suggestedName}
										tagSuggestions={tagSuggestions}
									/>
								</div>
							</div>
						</div>

						<RuleActionBar
							editing={!!editingRule}
							saving={savingRule}
							validationIssues={validationIssues}
							onCancel={() => navigate({ to: "/alerts" })}
							onSave={handleSave}
							onShowTemplates={editingRule ? undefined : () => setTemplatesOpen(true)}
							cancelSlot={
								<Button type="button" variant="outline" render={<Link to="/alerts" />}>
									Cancel
								</Button>
							}
						/>

						<RuleTemplatesOverlay
							open={templatesOpen}
							onOpenChange={setTemplatesOpen}
							onPick={(template) => {
								setRuleForm((current) => applyTemplate(template, current))
								setTemplatesOpen(false)
							}}
							onStartBlank={() => setTemplatesOpen(false)}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function deriveValidationIssues(form: RuleFormState, destinations: AlertDestinationDocument[]): string[] {
	const issues: string[] = []
	if (form.name.trim().length === 0) issues.push("Rule name")
	if (!Number.isFinite(Number(form.threshold))) issues.push("Threshold")
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) {
		issues.push("Upper threshold")
	}
	// The four timing fields silently fall back to a default when they don't parse
	// (see `parsePositiveNumber` in form-utils), so name them here rather than
	// letting a typo save as a different rule than the one on screen.
	for (const [label, value] of [
		["Window (min)", form.windowMinutes],
		["Breaches to fire", form.consecutiveBreachesRequired],
		["Healthy to resolve", form.consecutiveHealthyRequired],
		["Renotify (min)", form.renotifyIntervalMinutes],
	] as const) {
		const parsed = Number(value)
		if (!Number.isFinite(parsed) || parsed <= 0) issues.push(label)
	}
	const minSamples = Number(form.minimumSampleCount)
	if (!Number.isFinite(minSamples) || minSamples < 0) issues.push("Min samples")
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length === 0) {
			issues.push("SQL query")
		} else if (!form.rawQuerySql.includes("$__orgFilter")) {
			issues.push("$__orgFilter in SQL")
		}
	}
	for (const issue of deriveRuleQueryIssues(form)) issues.push(issue)
	if (destinations.length === 0) {
		issues.push("A notification destination")
	} else if (form.destinationIds.length === 0) {
		issues.push("At least one destination")
	}
	return issues
}

/**
 * Identity of the rule *as evaluated*. Derived from the exact payload the test
 * endpoint receives, minus the fields that don't change the verdict (name,
 * notes, tags, destinations, notification template) — so retitling a rule keeps
 * its verdict but retuning the threshold discards it.
 */
function previewIdentityKey(form: RuleFormState): string {
	const {
		name: _name,
		notes: _notes,
		tags: _tags,
		destination_ids: _destinationIds,
		notification_template: _notificationTemplate,
		enabled: _enabled,
		...evaluated
	} = buildRuleCreateParamsV2(form)
	return JSON.stringify(evaluated)
}

function makeSuggestedName(form: RuleFormState): string | null {
	if (form.name.trim().length > 0) return null
	const base = signalLabels[form.signalType]
	const queryGroupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns?.groupBy
			? (form.queryBuilderDraft.groupBy ?? [])
			: []
	const queryOwnsScope = form.signalType === "builder_query" || form.signalType === "raw_query"
	const scope = queryOwnsScope
		? queryGroupBy.length > 0
			? `per ${queryGroupBy.join(" · ")}`
			: null
		: form.serviceNames.length === 1
			? form.serviceNames[0]!
			: form.serviceNames.length > 1
				? `${form.serviceNames.length} services`
				: form.groupBy.length > 0
					? `per ${form.groupBy.join(" · ")}`
					: null
	const env = !queryOwnsScope && form.environments.length > 0 ? form.environments.join(" · ") : null
	const suffix = [scope, env].filter((part) => part !== null).join(" · ")
	return suffix.length > 0 ? `${base} — ${suffix}` : base
}
