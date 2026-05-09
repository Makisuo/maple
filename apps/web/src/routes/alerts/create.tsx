import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { RuleSentenceBuilder } from "@/components/alerts/rule-sentence-builder"
import {
	AlertSegmentedSelect,
	AlertMultiSegmentedSelect,
	type AlertSegmentedOption,
} from "@/components/alerts/alert-segmented-select"
import {
	type RuleFormState,
	defaultRuleForm,
	ruleToFormState,
	buildRuleRequest,
	buildRuleTestRequest,
	isRulePreviewReady,
	getExitErrorMessage,
	comparatorLabels,
	metricTypeLabels,
	metricAggregationLabels,
	destinationTypeLabels,
	signalLabels,
	formatSignalValue,
} from "@/lib/alerts/form-utils"
import {
	AlertDestinationDocument,
	AlertRuleDocument,
	type AlertMetricAggregation,
	type AlertMetricType,
} from "@maple/domain/http"
import { EyeIcon, LoaderIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import {
	Combobox,
	ComboboxChips,
	ComboboxChip,
	ComboboxChipsInput,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"
import { AGGREGATIONS_BY_SOURCE } from "@/lib/query-builder/model"
import { GroupByMultiSelect } from "@/components/query-builder/group-by-multi-select"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { AutocompleteValuesProvider, useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"

const AlertCreateSearch = Schema.Struct({
	serviceName: Schema.optional(Schema.String),
	ruleId: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/create"))({
	component: AlertCreatePageWrapper,
	validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

function AlertCreatePageWrapper() {
	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")
	return (
		<AutocompleteValuesProvider startTime={startTime} endTime={endTime}>
			<AlertCreatePage />
		</AutocompleteValuesProvider>
	)
}

function AlertCreatePage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {
		reactivityKeys: ["alertDestinations"],
	})
	const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", { reactivityKeys: ["alertRules"] })
	const destinationsResult = useAtomValue(destinationsQueryAtom)
	const rulesResult = useAtomValue(rulesQueryAtom)

	const createRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "createRule"), {
		mode: "promiseExit",
	})
	const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), {
		mode: "promiseExit",
	})
	const testRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "testRule"), { mode: "promiseExit" })

	const autocompleteValues = useAutocompleteValuesContext()
	const serviceNameOptions = autocompleteValues.traces.services ?? []

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [])

	const rules = Result.builder(rulesResult)
		.onSuccess((response) => [...response.rules] as AlertRuleDocument[])
		.orElse(() => [])

	const editingRule = useMemo(() => {
		if (!search.ruleId) return null
		return rules.find((r) => r.id === search.ruleId) ?? null
	}, [search.ruleId, rules])

	const [ruleForm, setRuleForm] = useState<RuleFormState>(() => defaultRuleForm(search.serviceName))
	const [savingRule, setSavingRule] = useState(false)
	const [previewingRule, setPreviewingRule] = useState(false)
	const [previewResult, setPreviewResult] = useState<{
		status: "breached" | "healthy" | "skipped"
		value: number | null
		sampleCount: number
		reason: string
	} | null>(null)
	const [initialized, setInitialized] = useState(false)

	useEffect(() => {
		if (editingRule && !initialized) {
			setRuleForm(ruleToFormState(editingRule))
			setInitialized(true)
		}
	}, [editingRule, initialized])

	const { chartData, chartLoading } = useAlertRuleChart(ruleForm)
	const threshold = Number(ruleForm.threshold)

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

	async function handleTestNotification() {
		if (!isRulePreviewReady(ruleForm)) {
			toast.error("Complete the rule name and threshold before testing")
			return
		}
		setPreviewingRule(true)
		const result = await testRule({
			payload: buildRuleTestRequest(ruleForm, ruleForm.destinationIds.length > 0),
			reactivityKeys: ["alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			setPreviewResult(result.value)
			toast.success(
				ruleForm.destinationIds.length > 0
					? "Preview ran and sent a test notification"
					: "Preview updated",
			)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to preview rule"))
		}
		setPreviewingRule(false)
	}

	const pageTitle = editingRule ? "Edit Alert Rule" : "Create Alert Rule"

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Alert Rules", href: "/alerts?tab=rules" },
				{ label: editingRule ? "Edit Rule" : "New Rule" },
			]}
			titleContent={
				<div className="flex items-center gap-2">
					<h1 className="text-2xl font-semibold tracking-tight truncate">{pageTitle}</h1>
					<Badge variant="secondary" className="text-xs font-medium">
						Beta
					</Badge>
				</div>
			}
			headerActions={
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to="/alerts" search={{ tab: "rules" }} />}
					>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={savingRule || destinations.length === 0}>
						{savingRule && <LoaderIcon size={14} className="animate-spin" />}
						Save Rule
					</Button>
				</div>
			}
		>
			<div className="flex gap-6">
				{/* ─── Left Column: Form ─── */}
				<div className="flex-1 min-w-0 space-y-6">
					{/* Sentence builder — hero rule statement */}
					<RuleSentenceBuilder form={ruleForm} onChange={setRuleForm} />

					{/* Metric-specific fields */}
					{ruleForm.signalType === "metric" && (
						<Card>
							<CardContent className="grid gap-4 p-4 sm:grid-cols-3">
								<div className="space-y-2 sm:col-span-3">
									<Label htmlFor="metric-name">Metric name</Label>
									<Input
										id="metric-name"
										value={ruleForm.metricName}
										onChange={(e) =>
											setRuleForm((c) => ({ ...c, metricName: e.target.value }))
										}
										placeholder="http.server.duration"
									/>
								</div>
								<div className="space-y-2">
									<Label>Metric type</Label>
									<Select
										items={metricTypeLabels}
										value={ruleForm.metricType}
										onValueChange={(value) =>
											setRuleForm((c) => ({
												...c,
												metricType: value as AlertMetricType,
											}))
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{Object.entries(metricTypeLabels).map(([val, label]) => (
												<SelectItem key={val} value={val}>
													{label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label>Aggregation</Label>
									<Select
										items={metricAggregationLabels}
										value={ruleForm.metricAggregation}
										onValueChange={(value) =>
											setRuleForm((c) => ({
												...c,
												metricAggregation: value as AlertMetricAggregation,
											}))
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{Object.entries(metricAggregationLabels).map(([val, label]) => (
												<SelectItem key={val} value={val}>
													{label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</CardContent>
						</Card>
					)}

					{/* Apdex threshold */}
					{ruleForm.signalType === "apdex" && (
						<div className="space-y-2">
							<Label htmlFor="apdex-threshold">Apdex threshold (ms)</Label>
							<Input
								id="apdex-threshold"
								type="number"
								value={ruleForm.apdexThresholdMs}
								onChange={(e) =>
									setRuleForm((c) => ({ ...c, apdexThresholdMs: e.target.value }))
								}
								className="max-w-[200px]"
							/>
						</div>
					)}

					{/* Custom Query builder */}
					{ruleForm.signalType === "query" && (
						<Card>
							<CardContent className="grid gap-4 p-4">
								<div className="space-y-2">
									<Label>Data source</Label>
									<AlertSegmentedSelect<"traces" | "logs" | "metrics">
										options={[
											{ value: "traces", label: "Traces" },
											{ value: "logs", label: "Logs" },
											{ value: "metrics", label: "Metrics" },
										]}
										value={ruleForm.queryDataSource}
										onChange={(ds) =>
											setRuleForm((c) => ({
												...c,
												queryDataSource: ds,
												queryAggregation: AGGREGATIONS_BY_SOURCE[ds][0].value,
											}))
										}
										aria-label="Query data source"
									/>
								</div>

								<div className="space-y-2">
									<Label>Aggregation</Label>
									<Select
										items={AGGREGATIONS_BY_SOURCE[ruleForm.queryDataSource]}
										value={ruleForm.queryAggregation}
										onValueChange={(value) => {
											if (value) setRuleForm((c) => ({ ...c, queryAggregation: value }))
										}}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{AGGREGATIONS_BY_SOURCE[ruleForm.queryDataSource].map((agg) => (
												<SelectItem key={agg.value} value={agg.value}>
													{agg.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{ruleForm.queryDataSource === "metrics" && (
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2 sm:col-span-2">
											<Label htmlFor="query-metric-name">Metric name</Label>
											<Input
												id="query-metric-name"
												value={ruleForm.metricName}
												onChange={(e) =>
													setRuleForm((c) => ({ ...c, metricName: e.target.value }))
												}
												placeholder="http.server.duration"
											/>
										</div>
										<div className="space-y-2">
											<Label>Metric type</Label>
											<Select
												value={ruleForm.metricType}
												onValueChange={(value) =>
													setRuleForm((c) => ({
														...c,
														metricType: value as AlertMetricType,
													}))
												}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{Object.entries(metricTypeLabels).map(([val, label]) => (
														<SelectItem key={val} value={val}>
															{label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									</div>
								)}

								<div className="space-y-2">
									<Label>Where</Label>
									<WhereClauseEditor
										dataSource={ruleForm.queryDataSource}
										value={ruleForm.queryWhereClause}
										onChange={(value) =>
											setRuleForm((c) => ({ ...c, queryWhereClause: value }))
										}
										rows={2}
										placeholder='service.name = "payments" AND has_error = true'
									/>
								</div>
							</CardContent>
						</Card>
					)}

					{/* Rule Name + Service */}
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="rule-name">Rule Name</Label>
							<Input
								id="rule-name"
								value={ruleForm.name}
								onChange={(e) => setRuleForm((c) => ({ ...c, name: e.target.value }))}
								placeholder="Error Rate — Payments"
							/>
						</div>
						<div className="space-y-2">
							<Label>Services</Label>
							<ServiceCombobox
								serviceNames={ruleForm.serviceNames}
								options={serviceNameOptions}
								onChange={(values) =>
									setRuleForm((c) => ({
										...c,
										serviceNames: values,
										groupBy: values.length > 0 ? [] : c.groupBy,
										excludeServiceNames: values.length > 0 ? [] : c.excludeServiceNames,
									}))
								}
							/>
							{ruleForm.serviceNames.length === 0 && (
								<>
									<div className="mt-2 space-y-1">
										<Label className="text-sm text-muted-foreground">Group by</Label>
										{(() => {
											const effectiveDataSource =
												ruleForm.signalType === "query"
													? ruleForm.queryDataSource
													: ruleForm.signalType === "metric"
														? "metrics"
														: "traces"
											return (
												<GroupByMultiSelect
													dataSource={effectiveDataSource}
													value={ruleForm.groupBy}
													onChange={(values) =>
														setRuleForm((c) => ({ ...c, groupBy: values }))
													}
													attributeKeys={
														autocompleteValues[effectiveDataSource]?.attributeKeys
													}
													placeholder="service.name"
													className="w-full"
												/>
											)
										})()}
										<p className="text-xs text-muted-foreground">
											Evaluate the rule per group. Each value (or composite of values)
											becomes its own incident.
										</p>
									</div>
									<div className="mt-2 space-y-1">
										<Label className="text-sm text-muted-foreground">
											Exclude services
										</Label>
										<ServiceCombobox
											serviceNames={ruleForm.excludeServiceNames}
											options={serviceNameOptions}
											onChange={(values) =>
												setRuleForm((c) => ({
													...c,
													excludeServiceNames: values,
												}))
											}
										/>
									</div>
								</>
							)}
						</div>
					</div>

					{/* Notify via */}
					<div>
						<Label className="mb-2 block">Notify via</Label>
						{destinations.length === 0 ? (
							<div className="text-muted-foreground text-sm">
								<Link to="/alerts" search={{ tab: "settings" }} className="underline">
									Create a destination
								</Link>{" "}
								before saving this rule.
							</div>
						) : (
							<AlertMultiSegmentedSelect<string>
								options={
									destinations.map((d) => ({
										value: d.id as unknown as string,
										label: (
											<span className="flex items-center gap-2">
												<span className="font-medium">{d.name}</span>
												<span className="text-muted-foreground text-xs">
													{destinationTypeLabels[d.type]}
												</span>
											</span>
										),
									})) satisfies AlertSegmentedOption<string>[]
								}
								value={ruleForm.destinationIds as unknown as string[]}
								onChange={(values) =>
									setRuleForm((current) => ({
										...current,
										destinationIds: values as typeof current.destinationIds,
									}))
								}
								aria-label="Notification destinations"
							/>
						)}
					</div>
				</div>

				{/* ─── Right Column: Live Preview ─── */}
				<div className="w-[380px] shrink-0 hidden lg:block">
					<Card className="sticky top-0">
						<CardContent className="p-5 space-y-5">
							{/* Header */}
							<div className="flex items-center justify-between">
								<h3 className="font-semibold">Live Preview</h3>
								<Button
									variant="outline"
									size="sm"
									onClick={handleTestNotification}
									disabled={previewingRule}
								>
									{previewingRule ? (
										<LoaderIcon size={14} className="animate-spin" />
									) : (
										<EyeIcon size={14} />
									)}
									Test Rule
								</Button>
							</div>

							{/* Current Value */}
							{previewResult && (
								<div className="space-y-1">
									<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
										Current value
									</span>
									<div className="flex items-baseline gap-2">
										<span
											className={cn(
												"text-2xl font-bold font-mono tabular-nums",
												previewResult.status === "breached"
													? "text-destructive"
													: "text-emerald-500",
											)}
										>
											{formatSignalValue(ruleForm.signalType, previewResult.value)}
										</span>
										<span className="text-muted-foreground text-sm">
											threshold: {formatSignalValue(ruleForm.signalType, threshold)}
										</span>
									</div>
									<AlertStatusBadge
										state={previewResult.status === "breached" ? "firing" : "ok"}
										label={
											previewResult.status === "breached"
												? "Would trigger alert"
												: "Within threshold"
										}
									/>
								</div>
							)}

							{/* Chart */}
							<div className="space-y-2">
								<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
									{signalLabels[ruleForm.signalType]}: Last 24h
								</span>
								<AlertPreviewChart
									data={chartData}
									threshold={Number.isFinite(threshold) ? threshold : 0}
									signalType={ruleForm.signalType}
									loading={chartLoading}
									className="h-[180px] w-full"
								/>
							</div>

							{/* Rule Summary — order matches detail page Config */}
							<div className="space-y-2">
								<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
									Rule summary
								</span>
								<dl className="space-y-2 text-sm">
									<div className="flex items-center justify-between">
										<dt className="text-muted-foreground">Signal</dt>
										<dd className="font-medium">{signalLabels[ruleForm.signalType]}</dd>
									</div>
									<div className="flex items-center justify-between">
										<dt className="text-muted-foreground">Condition</dt>
										<dd className="font-mono font-medium">
											{comparatorLabels[ruleForm.comparator]} {ruleForm.threshold} /{" "}
											{ruleForm.windowMinutes}min
										</dd>
									</div>
									<div className="flex items-center justify-between gap-4">
										<dt className="text-muted-foreground">Scope</dt>
										<dd className="flex flex-wrap gap-1 justify-end">
											{ruleForm.serviceNames.length > 0 ? (
												ruleForm.serviceNames.map((s) => (
													<Badge key={s} variant="outline" className="text-xs">
														{s}
													</Badge>
												))
											) : (
												<span className="font-mono font-medium">
													{ruleForm.groupBy.length > 0
														? `all (per ${ruleForm.groupBy.join(" \u00b7 ")})`
														: "all"}
												</span>
											)}
										</dd>
									</div>
									{ruleForm.excludeServiceNames.length > 0 && (
										<div className="flex items-center justify-between gap-4">
											<dt className="text-muted-foreground">Excluded</dt>
											<dd className="flex flex-wrap gap-1 justify-end">
												{ruleForm.excludeServiceNames.map((s) => (
													<Badge
														key={s}
														variant="outline"
														className="text-xs line-through"
													>
														{s}
													</Badge>
												))}
											</dd>
										</div>
									)}
									<div className="flex items-center justify-between">
										<dt className="text-muted-foreground">Severity</dt>
										<dd
											className={cn(
												"font-medium capitalize",
												ruleForm.severity === "critical"
													? "text-destructive"
													: "text-severity-warn",
											)}
										>
											{ruleForm.severity}
										</dd>
									</div>
									<div className="flex items-center justify-between">
										<dt className="text-muted-foreground">Destinations</dt>
										<dd className="font-medium tabular-nums">
											{ruleForm.destinationIds.length} selected
										</dd>
									</div>
								</dl>
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</DashboardLayout>
	)
}

function ServiceCombobox({
	serviceNames,
	options,
	onChange,
}: {
	serviceNames: string[]
	options: string[]
	onChange: (values: string[]) => void
}) {
	const anchor = useRef<HTMLDivElement | null>(null)
	return (
		<Combobox multiple value={serviceNames} onValueChange={onChange}>
			<ComboboxChips ref={anchor}>
				{serviceNames.map((name) => (
					<ComboboxChip key={name}>{name}</ComboboxChip>
				))}
				<ComboboxChipsInput
					placeholder={serviceNames.length === 0 ? "All services" : "Add service..."}
				/>
			</ComboboxChips>
			<ComboboxContent anchor={anchor}>
				<ComboboxEmpty>No services found.</ComboboxEmpty>
				<ComboboxList>
					{options.map((svc) => (
						<ComboboxItem key={svc} value={svc}>
							{svc}
						</ComboboxItem>
					))}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}
