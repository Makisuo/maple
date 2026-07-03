import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Fragment, useMemo, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { presetLabel, formatTimeRangeDisplay } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { AlertSignalChart } from "@/components/alerts/alert-signal-chart"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatStrip } from "@/components/alerts/alert-stat-card"
import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import {
	signalLabels,
	comparatorLabels,
	formatSignalValue,
	defaultRuleForm,
	ruleToFormState,
	formatAlertDateTimeFull,
	formatAlertDuration,
	computeIncidentStats,
} from "@/lib/alerts/form-utils"
import {
	AlertRuleId,
	IsoDateTimeString,
	type AiTriageResult,
	type AlertCheckDocument,
	type AlertIncidentDocument,
	type AlertRuleDocument,
} from "@maple/domain/http"
import { AiTriageCard } from "@/components/ai-triage/ai-triage-card"
import { AlertChatSheet } from "@/components/alerts/alert-chat-sheet"
import { toAlertContext, type AlertContext } from "@/components/chat/alert-context"
import {
	CheckIcon,
	PencilIcon,
	DotsVerticalIcon,
	CircleWarningIcon,
	ChevronDownIcon,
	ChatBubbleSparkleIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"
import { tokenizeSql } from "@/lib/sql-highlight"
import { formatSql } from "@/lib/sql-format"

const tabValues = ["overview", "history"] as const
type RuleDetailTab = (typeof tabValues)[number]

const RuleDetailSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/$ruleId"))({
	component: RuleDetailPage,
	validateSearch: Schema.toStandardSchemaV1(RuleDetailSearch),
})

function RuleDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<RuleDetailContent />
		</PageRefreshProvider>
	)
}

function RuleDetailContent() {
	const { ruleId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	// Page-level time window (24h default), shared by the chart, checks, and the
	// header timeline strip — the standard services/errors wiring.
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)
	// listRuleChecks takes ISO `since`/`until`; the effective range is Tinybird
	// format ("YYYY-MM-DD HH:mm:ss"), so normalize before converting.
	const since = useMemo(
		() => IsoDateTimeString.make(new Date(normalizeTimestampInput(startTime)).toISOString()),
		[startTime],
	)
	const until = useMemo(
		() => IsoDateTimeString.make(new Date(normalizeTimestampInput(endTime)).toISOString()),
		[endTime],
	)

	const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {
		reactivityKeys: ["alertRules"],
	})
	const rulesResult = useAtomValue(rulesQueryAtom)
	const refreshRules = useAtomRefresh(rulesQueryAtom)
	const incidentsQueryAtom = MapleApiAtomClient.query("alerts", "listIncidents", {
		reactivityKeys: ["alertIncidents"],
	})
	const incidentsResult = useAtomValue(incidentsQueryAtom)
	const refreshIncidents = useAtomRefresh(incidentsQueryAtom)
	const checksQueryAtom = MapleApiAtomClient.query("alerts", "listRuleChecks", {
		params: { ruleId: ruleId as AlertRuleId },
		query: { since, until },
		reactivityKeys: ["alertChecks", ruleId, since, until],
	})
	const checksResult = useAtomValue(checksQueryAtom)
	const refreshChecks = useAtomRefresh(checksQueryAtom)

	const rules = Result.builder(rulesResult)
		.onSuccess((response) => response.rules)
		.orElse(() => [])
	const allIncidents = Result.builder(incidentsResult)
		.onSuccess((response) => response.incidents)
		.orElse(() => [])
	const checks = Result.builder(checksResult)
		.onSuccess((response) => response.checks)
		.orElse(() => [])

	const rule = useMemo(() => rules.find((r) => r.id === ruleId) ?? null, [rules, ruleId])

	const ruleIncidents = useMemo(
		() =>
			allIncidents
				.filter((i) => i.ruleId === ruleId)
				.sort((a, b) => {
					const dateA = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
					const dateB = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
					return dateB - dateA
				}),
		[allIncidents, ruleId],
	)

	const activeTab: RuleDetailTab = (tabValues as readonly string[]).includes(search.tab ?? "")
		? (search.tab as RuleDetailTab)
		: "overview"

	const [stateFilter, setStateFilter] = useState<"all" | "open" | "resolved">("all")
	const [checkStatusFilter, setCheckStatusFilter] = useState<"all" | "breached" | "healthy" | "skipped">(
		"all",
	)

	const filteredIncidents = useMemo(() => {
		if (stateFilter === "all") return ruleIncidents
		return ruleIncidents.filter((i) => i.status === stateFilter)
	}, [ruleIncidents, stateFilter])

	// Incident the Overview AI-summary card binds to: the open one, else most recent.
	const overviewIncident = useMemo(
		() => ruleIncidents.find((i) => i.status === "open") ?? ruleIncidents[0] ?? null,
		[ruleIncidents],
	)

	// Integrated alert chat slide-over, seeded with an incident's context.
	const [chatContext, setChatContext] = useState<AlertContext | null>(null)
	const [chatOpen, setChatOpen] = useState(false)
	// History rows lazily mount their own triage card only when expanded.
	const [expandedIncidentId, setExpandedIncidentId] = useState<string | null>(null)

	const openAlertChat = (incident: AlertIncidentDocument, result?: AiTriageResult | null) => {
		if (!rule) return
		setChatContext(toAlertContext(rule, incident, result))
		setChatOpen(true)
	}

	const stats = useMemo(() => computeIncidentStats(ruleIncidents), [ruleIncidents])
	const maxContributorCount = stats.topContributors.length > 0 ? stats.topContributors[0][1] : 1

	// Timeline bar segments for sticky header
	const timelineSegments = useMemo(() => {
		if (ruleIncidents.length === 0) return []
		const sorted = ruleIncidents.toSorted((a, b) => {
			const ta = a.firstTriggeredAt ? new Date(a.firstTriggeredAt).getTime() : 0
			const tb = b.firstTriggeredAt ? new Date(b.firstTriggeredAt).getTime() : 0
			return ta - tb
		})
		return sorted.map((i) => ({
			status: i.status as "open" | "resolved",
			start: i.firstTriggeredAt ? new Date(i.firstTriggeredAt).getTime() : Date.now(),
			end: i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now(),
		}))
	}, [ruleIncidents])

	// The strip frames the selected window so "today" vs "last week" reshapes the
	// at-a-glance answer; incident segments still paint wherever they fall within it.
	const timelineRange = useMemo(
		() => ({
			min: new Date(normalizeTimestampInput(startTime)).getTime(),
			max: new Date(normalizeTimestampInput(endTime)).getTime(),
		}),
		[startTime, endTime],
	)

	const formState = useMemo(() => (rule ? ruleToFormState(rule) : defaultRuleForm()), [rule])
	const { chartData, chartLoading, chartError } = useAlertRuleChart(formState, { startTime, endTime })

	// Mirror the picker's default: a custom range formats its bounds, otherwise the
	// preset label (falling back to the same "24h" the header + data window use).
	const rangeLabel =
		search.startTime && search.endTime
			? formatTimeRangeDisplay(search.startTime, search.endTime)
			: presetLabel(search.timePreset ?? "24h")

	if (Result.isInitial(rulesResult)) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: "Loading..." }]}
			>
				<div className="space-y-4">
					<Skeleton className="h-12 w-1/3" />
					<Skeleton className="h-48 w-full" />
				</div>
			</DashboardLayout>
		)
	}

	if (Result.isFailure(rulesResult)) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: "Error" }]}
				title="Failed to load alert rule"
			>
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CircleWarningIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>Failed to load alert rule</EmptyTitle>
						<EmptyDescription>
							{Result.builder(rulesResult)
								.onError((error) => error.message)
								.orElse(() => undefined) ?? "Try refreshing or check API logs."}
						</EmptyDescription>
					</EmptyHeader>
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={() => refreshRules()}>
							Retry
						</Button>
						<Button
							variant="outline"
							size="sm"
							render={<Link to="/alerts" search={{ tab: "rules" }} />}
						>
							Back to rules
						</Button>
					</div>
				</Empty>
			</DashboardLayout>
		)
	}

	if (!rule) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: "Not Found" }]}
				title="Rule not found"
			>
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CircleWarningIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>Rule not found</EmptyTitle>
						<EmptyDescription>
							This alert rule could not be found. It may have been deleted.
						</EmptyDescription>
					</EmptyHeader>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/alerts" search={{ tab: "rules" }} />}
					>
						Back to rules
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}

	const isFiring = ruleIncidents.some((i) => i.status === "open")
	const subtitle = `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, rule.threshold)} over ${rule.windowMinutes}min${rule.serviceNames?.length > 0 ? ` on ${rule.serviceNames.join(", ")}` : ""}${rule.excludeServiceNames?.length > 0 ? ` (excl. ${rule.excludeServiceNames.join(", ")})` : ""}`

	const stickyContent = (
		<div className="space-y-3">
			<div className="space-y-1">
				<div className="flex items-center gap-[3px]">
					{Array.from({ length: 45 }, (_, i) => {
						const totalRange = timelineRange.max - timelineRange.min
						const bucketStart = timelineRange.min + (i / 45) * totalRange
						const bucketEnd = timelineRange.min + ((i + 1) / 45) * totalRange
						const hit = timelineSegments.find(
							(seg) => seg.end > bucketStart && seg.start < bucketEnd,
						)
						return (
							<div
								key={i}
								className={cn(
									"h-3 flex-1 rounded-[2px]",
									hit
										? hit.status === "open"
											? "bg-destructive"
											: "bg-destructive/50"
										: "bg-chart-apdex/60",
								)}
							/>
						)
					})}
				</div>
				<div className="flex justify-between text-[11px] text-muted-foreground font-mono">
					<span>
						{new Date(timelineRange.min).toLocaleString(undefined, {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
					<span>
						{new Date(timelineRange.max).toLocaleString(undefined, {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
				</div>
			</div>
			<Tabs
				value={activeTab}
				onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, tab: v as RuleDetailTab }) })}
			>
				<TabsList variant="underline">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="history">History</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	)

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Alert Rules", href: "/alerts?tab=rules" }, { label: rule.name }]}
			titleContent={
				<div>
					<div className="flex items-center gap-2 flex-wrap">
						<h1 className="text-2xl font-semibold tracking-tight truncate">{rule.name}</h1>
						<AlertSeverityBadge severity={rule.severity} />
						{isFiring ? (
							<AlertStatusBadge state="firing" />
						) : rule.enabled ? (
							<AlertStatusBadge state="ok" />
						) : (
							<AlertStatusBadge state="disabled" />
						)}
					</div>
					<p className="text-muted-foreground mt-0.5">{subtitle}</p>
				</div>
			}
			headerActions={
				<div className="flex items-center gap-2">
					<TimeRangeHeaderControls
						startTime={search.startTime}
						endTime={search.endTime}
						presetValue={search.timePreset ?? "24h"}
						defaultPreset="24h"
						onTimeChange={(range) =>
							navigate({ search: (prev) => applyTimeRangeSearch(prev, range) })
						}
					/>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/alerts/create" search={{ ruleId: rule.id }} />}
					>
						<PencilIcon size={14} />
						Edit rule
					</Button>
				</div>
			}
			stickyContent={stickyContent}
		>
			{activeTab === "overview" && (
				<div className="space-y-6">
					{rule.lastEvaluationError && (
						<div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4">
							<CircleWarningIcon size={18} className="mt-0.5 shrink-0 text-destructive" />
							<div className="min-w-0 space-y-1">
								<p className="text-sm font-medium text-destructive">Last evaluation failed</p>
								<p className="text-sm text-muted-foreground break-words">
									{rule.lastEvaluationError}
								</p>
								{rule.lastEvaluatedAt && (
									<p className="text-xs text-muted-foreground">
										{formatRelativeTime(rule.lastEvaluatedAt)}
									</p>
								)}
							</div>
						</div>
					)}
					<div className="space-y-2">
						<h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							{signalLabels[rule.signalType]}: {rangeLabel}
						</h2>
						<AlertSignalChart
							data={chartData}
							checks={checks}
							incidents={ruleIncidents}
							threshold={rule.threshold}
							thresholdUpper={rule.thresholdUpper}
							comparator={rule.comparator}
							signalType={rule.signalType}
							window={timelineRange}
							loading={
								chartLoading ||
								(rule.signalType === "raw_query" && Result.isInitial(checksResult))
							}
							chartError={chartError}
						/>
					</div>

					{overviewIncident ? (
						<AiTriageCard
							incidentKind="alert"
							incidentId={overviewIncident.id}
							issueId={overviewIncident.errorIssueId ?? undefined}
							onOpenChat={(result) => openAlertChat(overviewIncident, result)}
						/>
					) : null}

					<div className="space-y-3">
						<h2 className="text-lg font-semibold">Configuration</h2>
						<Card>
							<CardContent className="p-5">
								<dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
									{rule.notes && (
										<div className="flex flex-col gap-1 sm:col-span-2">
											<dt className="text-muted-foreground">Notes</dt>
											<dd className="whitespace-pre-wrap text-foreground">
												{rule.notes}
											</dd>
										</div>
									)}
									<ConfigRow label="Signal">
										<span className="font-medium">{signalLabels[rule.signalType]}</span>
									</ConfigRow>
									<ConfigRow label="Scope">
										<div className="flex flex-wrap gap-1 justify-end">
											{rule.serviceNames?.length > 0 ? (
												rule.serviceNames.map((s) => (
													<Badge key={s} variant="outline" className="text-xs">
														{s}
													</Badge>
												))
											) : (
												<span className="font-mono font-medium">
													{rule.groupBy && rule.groupBy.length > 0
														? `all (per ${rule.groupBy.join(" \u00b7 ")})`
														: "all"}
												</span>
											)}
										</div>
									</ConfigRow>
									{rule.excludeServiceNames?.length > 0 && (
										<ConfigRow label="Excluded">
											<div className="flex flex-wrap gap-1 justify-end">
												{rule.excludeServiceNames.map((s) => (
													<Badge
														key={s}
														variant="outline"
														className="text-xs line-through"
													>
														{s}
													</Badge>
												))}
											</div>
										</ConfigRow>
									)}
									<ConfigRow label="Condition">
										<span className="font-mono font-medium">
											{comparatorLabels[rule.comparator]}{" "}
											{formatSignalValue(rule.signalType, rule.threshold)} /{" "}
											{rule.windowMinutes}min
										</span>
									</ConfigRow>
									<ConfigRow label="Severity">
										<AlertSeverityBadge severity={rule.severity} />
									</ConfigRow>
									<ConfigRow label="Consecutive breaches">
										<span className="font-medium tabular-nums">
											{rule.consecutiveBreachesRequired}
										</span>
									</ConfigRow>
									<ConfigRow label="Healthy to resolve">
										<span className="font-medium tabular-nums">
											{rule.consecutiveHealthyRequired}
										</span>
									</ConfigRow>
									<ConfigRow label="Min samples">
										<span className="font-medium tabular-nums">
											{rule.minimumSampleCount}
										</span>
									</ConfigRow>
									<ConfigRow label="Renotify interval">
										<span className="font-medium">{rule.renotifyIntervalMinutes}min</span>
									</ConfigRow>
									{rule.signalType === "builder_query" && rule.queryBuilderDraft && (
										<>
											<ConfigRow label="Data source">
												<span className="font-mono font-medium capitalize">
													{rule.queryBuilderDraft.dataSource}
												</span>
											</ConfigRow>
											<ConfigRow label="Aggregation">
												<span className="font-mono font-medium">
													{rule.queryBuilderDraft.aggregation}
												</span>
											</ConfigRow>
											{rule.queryBuilderDraft.whereClause && (
												<ConfigRow label="Where" wide>
													<span className="font-mono font-medium text-right">
														{rule.queryBuilderDraft.whereClause}
													</span>
												</ConfigRow>
											)}
										</>
									)}
									{rule.signalType === "raw_query" && rule.rawQuerySql && (
										<div className="flex flex-col gap-1.5 sm:col-span-2">
											<dt className="text-muted-foreground">Raw SQL</dt>
											<dd>
												<pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted/30 px-3 py-2.5 font-mono text-xs leading-relaxed">
													<code>
														{tokenizeSql(formatSql(rule.rawQuerySql)).map(
															(token) => (
																<span
																	key={token.start}
																	className={token.className}
																>
																	{token.text}
																</span>
															),
														)}
													</code>
												</pre>
											</dd>
										</div>
									)}
									<ConfigRow label="Destinations">
										<span className="font-medium">
											{rule.destinationIds.length} configured
										</span>
									</ConfigRow>
									<ConfigRow label="Status">
										<AlertStatusBadge
											state={rule.enabled ? "ok" : "disabled"}
											label={rule.enabled ? "Enabled" : "Disabled"}
										/>
									</ConfigRow>
								</dl>
							</CardContent>
						</Card>
					</div>

					{Result.builder(checksResult)
						.onError((error) => (
							<div className="space-y-4">
								<h2 className="text-lg font-semibold">Checks</h2>
								<Empty className="py-12">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<CircleWarningIcon size={18} />
										</EmptyMedia>
										<EmptyTitle>Failed to load checks</EmptyTitle>
										<EmptyDescription>
											{error.message ?? "Try refreshing or check API logs."}
										</EmptyDescription>
									</EmptyHeader>
									<Button variant="outline" size="sm" onClick={() => refreshChecks()}>
										Retry
									</Button>
								</Empty>
							</div>
						))
						.orElse(() => (
							<ChecksPanel
								rule={rule}
								checks={checks}
								loading={Result.isInitial(checksResult)}
								statusFilter={checkStatusFilter}
								setStatusFilter={setCheckStatusFilter}
							/>
						))}
				</div>
			)}

			{activeTab === "history" &&
				Result.builder(incidentsResult)
					.onInitial(() => (
						<div className="space-y-4">
							<Skeleton className="h-24 w-full" />
							<Skeleton className="h-64 w-full" />
						</div>
					))
					.onError((error) => (
						<Empty className="py-12">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<CircleWarningIcon size={18} />
								</EmptyMedia>
								<EmptyTitle>Failed to load incidents</EmptyTitle>
								<EmptyDescription>
									{error.message ?? "Try refreshing or check API logs."}
								</EmptyDescription>
							</EmptyHeader>
							<Button variant="outline" size="sm" onClick={() => refreshIncidents()}>
								Retry
							</Button>
						</Empty>
					))
					.onSuccess(() => (
						<div className="space-y-6">
							<div className="flex items-center justify-between">
								<div>
									<h2 className="text-lg font-semibold">History</h2>
									<p className="text-muted-foreground text-sm">
										{stats.totalTriggered} total triggers
									</p>
								</div>
								<AlertSegmentedSelect<"all" | "open" | "resolved">
									options={[
										{ value: "all", label: "All" },
										{ value: "open", label: "Fired" },
										{ value: "resolved", label: "Resolved" },
									]}
									value={stateFilter}
									onChange={setStateFilter}
									size="sm"
									aria-label="Filter incidents"
								/>
							</div>

							<AlertStatStrip
								items={[
									{ label: "Total triggered", value: stats.totalTriggered },
									{ label: "Avg resolution", value: stats.avgResolution },
								]}
							/>

							{stats.topContributors.length > 0 && (
								<div className="space-y-2">
									<h3 className="text-sm font-semibold">Top contributors</h3>
									<Card>
										<CardContent className="space-y-2 p-5">
											{stats.topContributors.map(([groupKey, count]) => (
												<div key={groupKey} className="flex items-center gap-2">
													<Badge
														variant="outline"
														className="text-xs shrink-0 truncate max-w-[160px]"
													>
														{groupKey}
													</Badge>
													<div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
														<div
															className={cn(
																"h-full rounded-full",
																count === maxContributorCount
																	? "bg-destructive"
																	: "bg-amber-500",
															)}
															style={{
																width: `${(count / maxContributorCount) * 100}%`,
															}}
														/>
													</div>
													<span className="text-xs text-muted-foreground tabular-nums shrink-0">
														{count}/{stats.totalTriggered}
													</span>
												</div>
											))}
										</CardContent>
									</Card>
								</div>
							)}

							{filteredIncidents.length === 0 ? (
								<Empty className="py-12">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<CheckIcon size={18} />
										</EmptyMedia>
										<EmptyTitle>No incidents</EmptyTitle>
										<EmptyDescription>
											This rule hasn't triggered any incidents in the selected filter.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-[100px]">State</TableHead>
											<TableHead className="w-[180px]">Group</TableHead>
											<TableHead>Labels</TableHead>
											<TableHead className="w-[180px]">Triggered at</TableHead>
											<TableHead className="w-[110px]">Duration</TableHead>
											<TableHead className="w-[70px]">Issue</TableHead>
											<TableHead className="w-[50px]" />
										</TableRow>
									</TableHeader>
									<TableBody>
										{filteredIncidents.map((incident) => {
											const isOpen = incident.status === "open"
											const isExpanded = expandedIncidentId === incident.id
											return (
												<Fragment key={incident.id}>
												<TableRow>
													<TableCell>
														<AlertStatusBadge
															state={isOpen ? "firing" : "resolved"}
														/>
													</TableCell>
													<TableCell>
														<span className="font-mono text-muted-foreground">
															{incident.groupKey ?? "all"}
														</span>
													</TableCell>
													<TableCell>
														<div className="flex flex-wrap gap-1">
															<Badge
																variant="secondary"
																className="text-xs font-mono"
															>
																{rule.signalType.replace("_", " ")}:{" "}
																{formatSignalValue(
																	rule.signalType,
																	incident.lastObservedValue,
																)}
															</Badge>
															<Badge
																variant="secondary"
																className="text-xs font-mono"
															>
																threshold:{" "}
																{formatSignalValue(
																	rule.signalType,
																	incident.threshold,
																)}
															</Badge>
														</div>
													</TableCell>
													<TableCell className="text-xs">
														{formatAlertDateTimeFull(incident.firstTriggeredAt)}
													</TableCell>
													<TableCell>
														<span
															className={cn(
																"text-xs tabular-nums",
																isOpen && "text-destructive font-medium",
															)}
														>
															{formatAlertDuration(
																incident.firstTriggeredAt,
																incident.resolvedAt,
															)}
														</span>
													</TableCell>
													<TableCell>
														{incident.errorIssueId != null ? (
															<Link
																to="/errors/issues/$issueId"
																params={{ issueId: incident.errorIssueId }}
																className="text-xs text-primary underline-offset-4 hover:underline"
															>
																View
															</Link>
														) : (
															<span className="text-xs text-muted-foreground/60">
																—
															</span>
														)}
													</TableCell>
													<TableCell>
														<div className="flex items-center justify-end gap-1">
															<Button
																variant="ghost"
																size="icon-sm"
																aria-label={isExpanded ? "Hide AI summary" : "Show AI summary"}
																aria-expanded={isExpanded}
																onClick={() =>
																	setExpandedIncidentId(
																		isExpanded ? null : incident.id,
																	)
																}
															>
																<ChevronDownIcon
																	size={14}
																	className={cn(
																		"transition-transform",
																		isExpanded && "rotate-180",
																	)}
																/>
															</Button>
															<DropdownMenu>
																<DropdownMenuTrigger
																	render={
																		<Button variant="ghost" size="icon-sm" />
																	}
																>
																	<DotsVerticalIcon size={14} />
																</DropdownMenuTrigger>
																<DropdownMenuContent align="end">
																	<DropdownMenuItem
																		onClick={() =>
																			setExpandedIncidentId(
																				isExpanded ? null : incident.id,
																			)
																		}
																	>
																		<ChatBubbleSparkleIcon size={14} />
																		{isExpanded ? "Hide AI summary" : "AI summary"}
																	</DropdownMenuItem>
																	<DropdownMenuItem
																		onClick={() =>
																			navigate({
																				to: "/alerts",
																				search: { tab: "monitor" },
																			})
																		}
																	>
																		View all incidents
																	</DropdownMenuItem>
																</DropdownMenuContent>
															</DropdownMenu>
														</div>
													</TableCell>
												</TableRow>
												{isExpanded ? (
													<TableRow className="bg-muted/30 hover:bg-muted/30">
														<TableCell colSpan={7} className="p-4">
															<AiTriageCard
																incidentKind="alert"
																incidentId={incident.id}
																issueId={incident.errorIssueId ?? undefined}
																onOpenChat={(result) =>
																	openAlertChat(incident, result)
																}
															/>
														</TableCell>
													</TableRow>
												) : null}
												</Fragment>
											)
										})}
									</TableBody>
								</Table>
							)}
						</div>
					))
					.render()}

			<AlertChatSheet open={chatOpen} onOpenChange={setChatOpen} alertContext={chatContext} />
		</DashboardLayout>
	)
}

function ConfigRow({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
	return (
		<div className={cn("flex items-center justify-between gap-4", wide && "sm:col-span-2")}>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right">{children}</dd>
		</div>
	)
}

function ChecksPanel({
	rule,
	checks,
	loading,
	statusFilter,
	setStatusFilter,
}: {
	rule: AlertRuleDocument
	checks: ReadonlyArray<AlertCheckDocument>
	loading: boolean
	statusFilter: "all" | "breached" | "healthy" | "skipped"
	setStatusFilter: (v: "all" | "breached" | "healthy" | "skipped") => void
}) {
	const totals = useMemo(() => {
		let breached = 0
		let healthy = 0
		let skipped = 0
		let transitions = 0
		for (const c of checks) {
			if (c.status === "breached") breached += 1
			else if (c.status === "healthy") healthy += 1
			else skipped += 1
			if (c.incidentTransition !== "none") transitions += 1
		}
		return { breached, healthy, skipped, transitions, total: checks.length }
	}, [checks])

	const filteredChecks = useMemo(() => {
		if (statusFilter === "all") return checks
		return checks.filter((c) => c.status === statusFilter)
	}, [checks, statusFilter])

	if (loading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		)
	}

	if (checks.length === 0) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CheckIcon size={18} />
					</EmptyMedia>
					<EmptyTitle>No checks in this window</EmptyTitle>
					<EmptyDescription>
						No evaluations were recorded for the selected time range. Try widening the
						range, or wait for the scheduler to record the next check.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="space-y-4">
			<h2 className="text-lg font-semibold">Checks</h2>
			<AlertStatStrip
				items={[
					{ label: "Total checks", value: totals.total },
					{
						label: "Breached",
						value: totals.breached,
						tone: totals.breached > 0 ? "critical" : "default",
					},
					{ label: "Healthy", value: totals.healthy, tone: "emerald" },
					{ label: "Transitions", value: totals.transitions },
				]}
			/>

			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">All checks</h3>
					<AlertSegmentedSelect<"all" | "breached" | "healthy" | "skipped">
						options={[
							{ value: "all", label: "All" },
							{ value: "breached", label: "Breached" },
							{ value: "healthy", label: "Healthy" },
							{ value: "skipped", label: "Skipped" },
						]}
						value={statusFilter}
						onChange={setStatusFilter}
						size="sm"
						aria-label="Filter checks"
					/>
				</div>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-[180px]">Time</TableHead>
							<TableHead className="w-[110px]">Status</TableHead>
							<TableHead className="w-[110px]">Value</TableHead>
							<TableHead className="w-[110px]">Threshold</TableHead>
							<TableHead className="w-[90px]">Samples</TableHead>
							<TableHead>Group</TableHead>
							<TableHead className="w-[140px]">Incident</TableHead>
							<TableHead className="w-[80px]">Eval ms</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredChecks.slice(0, 200).map((check) => {
							const state: "firing" | "ok" | "pending" =
								check.status === "breached"
									? "firing"
									: check.status === "healthy"
										? "ok"
										: "pending"
							const transitionTone =
								check.incidentTransition === "opened"
									? "text-destructive"
									: check.incidentTransition === "resolved"
										? "text-emerald-500"
										: check.incidentTransition === "continued"
											? "text-muted-foreground"
											: ""
							return (
								<TableRow key={`${check.timestamp}-${check.groupKey}`}>
									<TableCell className="font-mono text-xs">
										{new Date(check.timestamp).toLocaleString()}
									</TableCell>
									<TableCell>
										<AlertStatusBadge
											state={state}
											label={
												check.status === "breached"
													? "Breached"
													: check.status === "healthy"
														? "Healthy"
														: "Skipped"
											}
										/>
									</TableCell>
									<TableCell className="font-mono tabular-nums">
										{check.observedValue == null
											? "—"
											: formatSignalValue(rule.signalType, check.observedValue)}
									</TableCell>
									<TableCell className="font-mono tabular-nums text-muted-foreground">
										{formatSignalValue(rule.signalType, check.threshold)}
									</TableCell>
									<TableCell className="tabular-nums">{check.sampleCount}</TableCell>
									<TableCell className="font-mono text-muted-foreground">
										{check.groupKey || "all"}
									</TableCell>
									<TableCell>
										{check.incidentTransition === "none" ? (
											<span className="text-muted-foreground">–</span>
										) : (
											<Badge
												variant="outline"
												className={cn("text-xs capitalize", transitionTone)}
											>
												{check.incidentTransition}
											</Badge>
										)}
									</TableCell>
									<TableCell className="tabular-nums text-muted-foreground">
										{check.evaluationDurationMs}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
				{filteredChecks.length > 200 && (
					<p className="text-xs text-muted-foreground text-center">
						Showing first 200 of {filteredChecks.length} matching checks.
					</p>
				)}
			</div>
		</div>
	)
}
