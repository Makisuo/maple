import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { useMemo, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import { CheckHistorySparkline } from "@/components/alerts/check-history-sparkline"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatCard } from "@/components/alerts/alert-stat-card"
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
	AlertIncidentDocument,
	AlertRuleId,
	type AlertCheckDocument,
	type AlertRuleDocument,
} from "@maple/domain/http"
import { CheckIcon, PencilIcon, DotsVerticalIcon, CircleWarningIcon } from "@/components/icons"
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

const tabValues = ["overview", "history", "checks"] as const
type RuleDetailTab = (typeof tabValues)[number]

const RuleDetailSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/$ruleId"))({
	component: RuleDetailPage,
	validateSearch: Schema.toStandardSchemaV1(RuleDetailSearch),
})

function RuleDetailPage() {
	const { ruleId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const rulesResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listRules", { reactivityKeys: ["alertRules"] }),
	)
	const incidentsResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listIncidents", { reactivityKeys: ["alertIncidents"] }),
	)
	const checksResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listRuleChecks", {
			params: { ruleId: ruleId as AlertRuleId },
			query: {},
			reactivityKeys: ["alertChecks", ruleId],
		}),
	)

	const rules = Result.builder(rulesResult)
		.onSuccess((response) => [...response.rules] as AlertRuleDocument[])
		.orElse(() => [])
	const allIncidents = Result.builder(incidentsResult)
		.onSuccess((response) => [...response.incidents] as AlertIncidentDocument[])
		.orElse(() => [] as AlertIncidentDocument[])
	const checks = Result.builder(checksResult)
		.onSuccess((response) => [...response.checks] as AlertCheckDocument[])
		.orElse(() => [] as AlertCheckDocument[])

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

	const timelineRange = useMemo(() => {
		if (timelineSegments.length === 0) return { min: Date.now() - 86_400_000 * 3, max: Date.now() }
		const starts = timelineSegments.map((s) => s.start)
		const ends = timelineSegments.map((s) => s.end)
		return { min: Math.min(...starts), max: Math.max(...ends, Date.now()) }
	}, [timelineSegments])

	const formState = useMemo(() => (rule ? ruleToFormState(rule) : defaultRuleForm()), [rule])
	const { chartData, chartLoading } = useAlertRuleChart(formState)

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
						nativeButton={false}
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
				<TabsList variant="line">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="history">History</TabsTrigger>
					<TabsTrigger value="checks">Checks</TabsTrigger>
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
						<Badge variant="secondary" className="text-xs font-medium">
							Beta
						</Badge>
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
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link to="/alerts/create" search={{ ruleId: rule.id }} />}
				>
					<PencilIcon size={14} />
					Edit rule
				</Button>
			}
			stickyContent={stickyContent}
		>
			{activeTab === "overview" && (
				<div className="space-y-6">
					<div className="space-y-2">
						<h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							{signalLabels[rule.signalType]}: Last 24h
						</h2>
						<AlertPreviewChart
							data={chartData}
							threshold={rule.threshold}
							signalType={rule.signalType}
							loading={chartLoading}
							className="h-[300px] w-full"
						/>
					</div>

					<div className="space-y-3">
						<h2 className="text-lg font-semibold">Configuration</h2>
						<Card>
							<CardContent className="p-5">
								<dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
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
									{rule.signalType === "query" && rule.queryDataSource && (
										<>
											<ConfigRow label="Data source">
												<span className="font-mono font-medium capitalize">
													{rule.queryDataSource}
												</span>
											</ConfigRow>
											<ConfigRow label="Aggregation">
												<span className="font-mono font-medium">
													{rule.queryAggregation}
												</span>
											</ConfigRow>
											{rule.queryWhereClause && (
												<ConfigRow label="Where" wide>
													<span className="font-mono font-medium text-right">
														{rule.queryWhereClause}
													</span>
												</ConfigRow>
											)}
										</>
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
				</div>
			)}

			{activeTab === "history" && (
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

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<AlertStatCard label="Total triggered" value={stats.totalTriggered} />
						<AlertStatCard label="Avg resolution" value={stats.avgResolution} />
						<Card>
							<CardContent className="p-5">
								<span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
									Top contributors
								</span>
								<div className="mt-3 space-y-2">
									{stats.topContributors.length === 0 ? (
										<span className="text-3xl font-bold">–</span>
									) : (
										stats.topContributors.map(([groupKey, count]) => (
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
										))
									)}
								</div>
							</CardContent>
						</Card>
					</div>

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
									<TableHead className="w-[50px]" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredIncidents.map((incident) => {
									const isOpen = incident.status === "open"
									return (
										<TableRow key={incident.id}>
											<TableCell>
												<AlertStatusBadge state={isOpen ? "firing" : "resolved"} />
											</TableCell>
											<TableCell>
												<span className="font-mono text-muted-foreground">
													{incident.groupKey ?? "all"}
												</span>
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													<Badge variant="secondary" className="text-xs font-mono">
														{rule.signalType.replace("_", " ")}:{" "}
														{formatSignalValue(
															rule.signalType,
															incident.lastObservedValue,
														)}
													</Badge>
													<Badge variant="secondary" className="text-xs font-mono">
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
												<DropdownMenu>
													<DropdownMenuTrigger
														render={<Button variant="ghost" size="icon-sm" />}
													>
														<DotsVerticalIcon size={14} />
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
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
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</div>
			)}

			{activeTab === "checks" && (
				<ChecksPanel
					rule={rule}
					checks={checks}
					loading={Result.isInitial(checksResult)}
					statusFilter={checkStatusFilter}
					setStatusFilter={setCheckStatusFilter}
				/>
			)}
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
	checks: AlertCheckDocument[]
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
					<EmptyTitle>No checks recorded yet</EmptyTitle>
					<EmptyDescription>
						Once this rule is evaluated the scheduler will record one check per minute here.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<AlertStatCard label="Total checks" value={totals.total} />
				<AlertStatCard
					label="Breached"
					value={totals.breached}
					tone={totals.breached > 0 ? "critical" : "default"}
				/>
				<AlertStatCard label="Healthy" value={totals.healthy} tone="emerald" />
				<AlertStatCard label="Transitions" value={totals.transitions} />
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">Observed values</h3>
					<span className="text-xs text-muted-foreground">
						{totals.total} checks · oldest → newest
					</span>
				</div>
				<Card>
					<CardContent className="p-5">
						<CheckHistorySparkline
							checks={checks}
							threshold={rule.threshold}
							signalType={rule.signalType}
							className="h-[200px] w-full"
						/>
					</CardContent>
				</Card>
			</div>

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
						{filteredChecks.slice(0, 200).map((check, idx) => {
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
								<TableRow key={`${check.timestamp}-${check.groupKey}-${idx}`}>
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
