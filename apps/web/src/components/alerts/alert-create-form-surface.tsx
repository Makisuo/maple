import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"

import { DetailsSection } from "@/components/alerts/details-section"
import { NotificationsSection } from "@/components/alerts/notifications-section"
import { RuleActionBar } from "@/components/alerts/rule-action-bar"
import { RuleLiveChartHero } from "@/components/alerts/rule-live-chart-hero"
import { RuleTemplatesOverlay } from "@/components/alerts/rule-templates-overlay"
import { ScopeSection } from "@/components/alerts/scope-section"
import { SignalAndThresholdSection } from "@/components/alerts/signal-and-threshold-section"
import { WidgetPrefillNoticeBanner } from "@/components/alerts/widget-prefill-notice-banner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import {
	buildRuleRequest,
	buildRuleTestRequest,
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
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useAlertRulesList } from "@/hooks/use-alerts-list"

export function AlertCreateFormSurface({
	initialForm,
	prefillNotices,
	editingRule,
	showTemplatesInitially,
	destinations,
	serviceNameOptions,
	autocompleteValues,
}: {
	initialForm: RuleFormState
	prefillNotices: WidgetAlertPrefillNotice[]
	editingRule: AlertRuleDocument | null
	showTemplatesInitially: boolean
	destinations: AlertDestinationDocument[]
	serviceNameOptions: string[]
	autocompleteValues: ReturnType<typeof useAutocompleteValuesContext>
}) {
	const navigate = useNavigate({ from: "/alerts/create" })
	const createRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "createRule"), {
		mode: "promiseExit",
	})
	const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), {
		mode: "promiseExit",
	})
	const testRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "testRule"), {
		mode: "promiseExit",
	})

	const [ruleForm, setRuleForm] = useState<RuleFormState>(() => initialForm)
	const [savingRule, setSavingRule] = useState(false)
	const [previewingRule, setPreviewingRule] = useState(false)
	const [sendingTestNotification, setSendingTestNotification] = useState(false)
	const [previewResult, setPreviewResult] = useState<{
		status: "breached" | "healthy" | "skipped"
		value: number | null
		sampleCount: number
		reason: string
	} | null>(null)

	// First-touch template picker: shown only when this is a fresh new-rule
	// entry with no pre-fills.
	const [templatesOpen, setTemplatesOpen] = useState(() => showTemplatesInitially)

	const { chartData, chartLoading, chartError } = useAlertRuleChart(ruleForm)

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
		const payload = buildRuleRequest(ruleForm)
		const result = editingRule
			? await updateRule({
					params: { ruleId: editingRule.id },
					payload,
					reactivityKeys: ["alertRules"],
				})
			: await createRule({ payload, reactivityKeys: ["alertRules"] })

		if (Exit.isSuccess(result)) {
			toast.success(editingRule ? "Rule updated" : "Rule created")
			navigate({ to: "/alerts", search: { tab: "rules" } })
		} else {
			toast.error(getExitErrorMessage(result, "Failed to save rule"))
		}
		setSavingRule(false)
	}

	async function runTest(sendNotification: boolean) {
		if (!isRulePreviewReady(ruleForm)) {
			toast.error("Complete the rule name, query, and threshold before testing")
			return
		}
		const setLoading = sendNotification ? setSendingTestNotification : setPreviewingRule
		setLoading(true)
		const result = await testRule({
			payload: buildRuleTestRequest(ruleForm, sendNotification),
			reactivityKeys: ["alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			setPreviewResult(result.value)
			toast.success(sendNotification ? "Preview ran and sent a test notification" : "Preview updated")
		} else {
			toast.error(getExitErrorMessage(result, "Failed to preview rule"))
		}
		setLoading(false)
	}

	const pageTitle = editingRule ? "Edit alert rule" : "Create alert rule"
	const showScope = ruleForm.signalType !== "builder_query" && ruleForm.signalType !== "raw_query"

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Alert Rules", href: "/alerts?tab=rules" },
				{ label: editingRule ? "Edit Rule" : "New Rule" },
			]}
			titleContent={
				<div className="flex items-center gap-2">
					<h1 className="font-display text-3xl font-semibold leading-[1.1] tracking-tight truncate">
						{pageTitle}
					</h1>
				</div>
			}
		>
			<div className="mx-auto w-full max-w-[1100px] space-y-4">
				<WidgetPrefillNoticeBanner notices={prefillNotices} />
				<RuleLiveChartHero
					form={ruleForm}
					chartData={chartData}
					chartLoading={chartLoading}
					chartError={chartError}
					onTestRule={() => runTest(false)}
					testing={previewingRule}
					previewResult={previewResult}
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
				onCancel={() => navigate({ to: "/alerts", search: { tab: "rules" } })}
				onSave={handleSave}
				onShowTemplates={editingRule ? undefined : () => setTemplatesOpen(true)}
				cancelSlot={
					<Button
						type="button"
						variant="outline"
						render={<Link to="/alerts" search={{ tab: "rules" }} />}
					>
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
		</DashboardLayout>
	)
}

function deriveValidationIssues(form: RuleFormState, destinations: AlertDestinationDocument[]): string[] {
	const issues: string[] = []
	if (form.name.trim().length === 0) issues.push("Rule name")
	if (!Number.isFinite(Number(form.threshold))) issues.push("Threshold")
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) {
		issues.push("Upper threshold")
	}
	if (form.signalType === "metric" && form.metricName.trim().length === 0) {
		issues.push("Metric name")
	}
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

function makeSuggestedName(form: RuleFormState): string | null {
	if (form.name.trim().length > 0) return null
	const base = signalLabels[form.signalType]
	const queryGroupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns?.groupBy
			? (form.queryBuilderDraft.groupBy ?? [])
			: []
	const scope =
		form.serviceNames.length === 1
			? form.serviceNames[0]!
			: form.serviceNames.length > 1
				? `${form.serviceNames.length} services`
				: queryGroupBy.length > 0
					? `per ${queryGroupBy.join(" · ")}`
					: form.groupBy.length > 0
						? `per ${form.groupBy.join(" · ")}`
						: null
	return scope ? `${base} — ${scope}` : base
}
