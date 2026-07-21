import React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Link, useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useAlertIncidentsList } from "@/hooks/use-alerts-list"
import {
	buildBaselineMap,
	baselineKey,
	type LatencyBaselineSignal,
	type ServiceHealth,
} from "@/components/dashboard/service-health"
import {
	serviceHealthRowKey,
	useServiceHealthSummary,
} from "@/components/services/use-service-health-summary"
import { formatTimeAgo } from "@/components/services/section-card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { Tooltip, TooltipTrigger, TooltipContent } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"
import { formatErrorRate } from "@maple/ui/lib/format"
import {
	CommitShaHoverCard,
	commitQueryAtom,
	firstLine,
	isResolvableSha,
} from "@/components/vcs/commit-sha-hover-card"
import { QueryErrorState } from "@/components/common/query-error-state"
import {
	type CommitBreakdown,
	type ServiceOverview,
	type ServiceTimeSeriesPoint,
} from "@/api/warehouse/services"
import {
	getCustomChartServiceSparklinesResultAtom,
	getServiceHealthBaselineResultAtom,
	getServiceOverviewResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { openAnomalyIncidentsAtom } from "@/lib/services/atoms/anomaly-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import type { ServicesSearchParams } from "@/routes/services/index"
import { ServiceDot } from "@maple/ui/components/service-dot"

// One fleet-level call: open (actionable) error-issue counts grouped by
// service name. Progressive enrichment — the table renders without it.
const openIssueCountsAtom = MapleApiV2AtomClient.query("errorIssues", "serviceCounts", {
	reactivityKeys: ["errorIssues"],
	timeToLive: 60_000,
})

function formatLatency(ms: number): string {
	if (ms == null || Number.isNaN(ms)) {
		return "-"
	}
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
}

function formatThroughput(rate: number): string {
	if (rate == null || Number.isNaN(rate) || rate === 0) {
		return "0/s"
	}
	if (rate >= 1000) {
		return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k/s`
	}
	if (rate >= 1) {
		return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}/s`
	}
	return `${rate.toLocaleString(undefined, { maximumFractionDigits: 3 })}/s`
}

function errorRateToneClass(rate: number): string {
	if (rate > 0.05) return "text-severity-error"
	if (rate > 0) return "text-severity-warn"
	return "text-muted-foreground"
}

/**
 * Search params for the per-service detail link. Carries the row's environment
 * so the detail page scopes its charts to the same environment the table row
 * measured (rows are grouped per environment; the synthetic `"unknown"` label is
 * remapped to the raw warehouse value server-side). Shared by all four
 * navigation sites (desktop row click + keydown + cell link, mobile link) so
 * they can't drift apart.
 */
function serviceDetailSearch(filters: ServicesSearchParams | undefined, environment: string) {
	return {
		startTime: filters?.startTime,
		endTime: filters?.endTime,
		timePreset: filters?.timePreset,
		environments: [environment],
	}
}

const ENVIRONMENT_PRIORITY: Record<string, number> = {
	production: 0,
	staging: 1,
	development: 2,
}

function groupByEnvironment(services: ServiceOverview[]): [string, ServiceOverview[]][] {
	const groups = new Map<string, ServiceOverview[]>()
	for (const service of services) {
		const env = service.environment
		if (!groups.has(env)) groups.set(env, [])
		groups.get(env)!.push(service)
	}
	return Array.from(groups.entries()).toSorted(([a], [b]) => {
		const pa = ENVIRONMENT_PRIORITY[a.toLowerCase()] ?? (a === "unknown" ? 999 : 3)
		const pb = ENVIRONMENT_PRIORITY[b.toLowerCase()] ?? (b === "unknown" ? 999 : 3)
		if (pa !== pb) return pa - pb
		return a.localeCompare(b)
	})
}

function truncateCommitSha(sha: string, length = 7): string {
	if (sha === "N/A" || sha === "unknown" || !sha) {
		return "N/A"
	}
	if (sha.length <= length) return sha
	return sha.slice(0, length)
}

// ---------------------------------------------------------------------------
// Health lane
// ---------------------------------------------------------------------------

const HEALTH_DOT_CLASS: Record<ServiceHealth, string> = {
	healthy: "bg-success",
	degraded: "bg-severity-warn",
	unhealthy: "bg-destructive",
}

/** Quiet health marker next to the service name — rendered only when there is
 *  something to say (degraded/unhealthy); healthy rows stay unadorned. */
function HealthDot({ health }: { health: ServiceHealth | undefined }) {
	if (health === undefined || health === "healthy") return null
	return (
		<span
			aria-label={health}
			title={health}
			className={cn("size-1.5 shrink-0 rounded-full", HEALTH_DOT_CLASS[health])}
		/>
	)
}

// ---------------------------------------------------------------------------
// P95 baseline delta
// ---------------------------------------------------------------------------

// Mirrors MIN_BASELINE_SPANS in service-health.ts: a baseline computed from
// fewer spans is noise, so the delta line is withheld entirely.
const MIN_BASELINE_SPANS = 100

interface BaselineDelta {
	label: string
	className: string
}

function baselineDelta(p95LatencyMs: number, baseline: LatencyBaselineSignal | undefined): BaselineDelta | undefined {
	if (baseline === undefined || baseline.spanCount < MIN_BASELINE_SPANS || baseline.p95LatencyMs <= 0) {
		return undefined
	}
	const delta = (p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs
	const pct = Math.round(delta * 100)
	return {
		label: `${pct > 0 ? "+" : ""}${pct}% vs 7d`,
		className:
			delta >= 1 ? "text-severity-error" : delta >= 0.25 ? "text-severity-warn" : "text-muted-foreground",
	}
}

// ---------------------------------------------------------------------------
// Last deploy cell
// ---------------------------------------------------------------------------

// Below this many spans on either side of the split, the errors-since-deploy
// comparison is too noisy to flag.
const MIN_DEPLOY_COMPARE_SPANS = 50
// A commit needs at least this share of traffic to count toward "mid-rollout".
const ROLLOUT_MIN_SHARE_PCT = 5

interface DeployCellInfo {
	sha: string
	firstSeen: string
	rollout?: { percentage: number; others: CommitBreakdown[] }
	errorsSince: boolean
}

function deriveDeployInfo(commits: CommitBreakdown[]): DeployCellInfo | undefined {
	const real = commits.filter((c) => c.commitSha && c.commitSha !== "N/A" && c.commitSha !== "unknown")
	if (real.length === 0) return undefined
	const dated = real.filter((c) => c.firstSeen !== "")
	const pool = dated.length > 0 ? dated : real
	const latest = pool.reduce((best, c) => (c.firstSeen > best.firstSeen ? c : best))
	const dominant = real.reduce((best, c) => (c.spanCount > best.spanCount ? c : best))

	const older = real.filter((c) => c !== latest)
	const olderSpans = older.reduce((sum, c) => sum + c.spanCount, 0)
	const olderErrors = older.reduce((sum, c) => sum + c.errorCount, 0)
	const latestRate = latest.spanCount > 0 ? latest.errorCount / latest.spanCount : 0
	const olderRate = olderSpans > 0 ? olderErrors / olderSpans : 0
	// "Errors ↑ since deploy": the newest commit errors at least twice as often
	// as everything it is replacing, by a margin that can't be rounding noise.
	const errorsSince =
		latest.spanCount >= MIN_DEPLOY_COMPARE_SPANS &&
		olderSpans >= MIN_DEPLOY_COMPARE_SPANS &&
		latestRate >= olderRate * 2 &&
		latestRate - olderRate >= 0.005

	const meaningful = real.filter((c) => c.percentage >= ROLLOUT_MIN_SHARE_PCT)
	const rollout =
		meaningful.length > 1
			? {
					percentage: dominant.percentage,
					others: real.filter((c) => c !== dominant).toSorted((a, b) => b.percentage - a.percentage),
				}
			: undefined

	return { sha: latest.commitSha, firstSeen: latest.firstSeen, rollout, errorsSince }
}

interface DeployLinesProps {
	sha: string
	firstSeen: string
	/** Replaces the default `sha · age` meta line (rollout / errors-since state). */
	stateLine: React.ReactNode | undefined
}

function deployMetaLine(text: string) {
	return text === "" ? null : (
		<span className="truncate font-mono text-[10px] text-muted-foreground">{text}</span>
	)
}

/**
 * Message-first deploy lines: subject line on top (once the deduped, cached
 * per-sha lookup resolves), `sha · age` demoted underneath. While unresolved —
 * or when the reference isn't a resolvable sha — the sha IS the headline, so
 * the meta line carries only the age instead of repeating it.
 */
function ResolvedDeployLines({ sha, firstSeen, stateLine }: DeployLinesProps) {
	const result = useAtomValue(commitQueryAtom(sha))
	const shortSha = truncateCommitSha(sha)
	const age = firstSeen !== "" ? formatTimeAgo(firstSeen) : ""
	const message = Result.isSuccess(result) ? firstLine(result.value.message) : ""
	return (
		<>
			<CommitShaHoverCard sha={sha} className="min-w-0 max-w-full truncate text-xs text-foreground">
				{message !== "" ? message : shortSha}
			</CommitShaHoverCard>
			{stateLine ?? deployMetaLine(message !== "" ? [shortSha, age].filter(Boolean).join(" · ") : age)}
		</>
	)
}

function DeployLines({ sha, firstSeen, stateLine }: DeployLinesProps) {
	if (isResolvableSha(sha)) {
		return <ResolvedDeployLines sha={sha} firstSeen={firstSeen} stateLine={stateLine} />
	}
	const age = firstSeen !== "" ? formatTimeAgo(firstSeen) : ""
	return (
		<>
			<CommitShaHoverCard sha={sha} className="min-w-0 max-w-full truncate text-xs text-foreground">
				{truncateCommitSha(sha)}
			</CommitShaHoverCard>
			{stateLine ?? deployMetaLine(age)}
		</>
	)
}

const DeployCell = React.memo(function DeployCell({ commits }: { commits: CommitBreakdown[] }) {
	const info = deriveDeployInfo(commits)
	if (info === undefined) {
		return <span className="text-xs text-muted-foreground">N/A</span>
	}
	const stateLine = info.errorsSince ? (
		<span className="truncate text-[10px] text-severity-error">
			{info.firstSeen !== "" ? `${formatTimeAgo(info.firstSeen)} · ` : ""}errors ↑ since
		</span>
	) : info.rollout !== undefined ? (
		<Tooltip>
			<TooltipTrigger className="flex cursor-default items-center gap-1.5">
				<span className="relative h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-muted">
					<span
						className="absolute inset-y-0 left-0 rounded-full bg-primary"
						style={{ width: `${info.rollout.percentage}%` }}
					/>
				</span>
				<span className="font-mono text-[10px] text-primary">
					{info.rollout.percentage}% · +{info.rollout.others.length}
				</span>
			</TooltipTrigger>
			<TooltipContent side="left" className="p-2">
				<div className="flex flex-col gap-1">
					{info.rollout.others.map((c) => (
						<div
							key={c.commitSha}
							className="flex items-center justify-between gap-3 font-mono text-xs"
						>
							<span>{truncateCommitSha(c.commitSha)}</span>
							<span className="tabular-nums text-muted-foreground">{c.percentage}%</span>
						</div>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	) : undefined
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<DeployLines sha={info.sha} firstSeen={info.firstSeen} stateLine={stateLine} />
		</div>
	)
})

// ---------------------------------------------------------------------------
// Environment group header
// ---------------------------------------------------------------------------

function EnvironmentBadge({ environment }: { environment: string }) {
	const getVariant = () => {
		switch (environment.toLowerCase()) {
			case "production":
				return "bg-severity-warn/15 text-severity-warn"
			case "staging":
				return "bg-chart-p50/15 text-chart-p50"
			case "development":
				return "bg-severity-debug/15 text-severity-debug"
			default:
				return ""
		}
	}

	return (
		<Badge variant="secondary" className={getVariant()}>
			{environment}
		</Badge>
	)
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ServiceRowProps {
	service: ServiceOverview
	series: ServiceTimeSeriesPoint[] | undefined
	filters: ServicesSearchParams | undefined
	health: ServiceHealth | undefined
	baseline: LatencyBaselineSignal | undefined
	issueCount: number | undefined
	navigate: ReturnType<typeof useNavigate>
}

const ServiceRow = React.memo(function ServiceRow({
	service,
	series,
	filters,
	health,
	baseline,
	issueCount,
	navigate,
}: ServiceRowProps) {
	const throughputData = React.useMemo(
		() => (series === undefined ? [] : series.map((p) => ({ value: p.throughput }))),
		[series],
	)
	const errorRateData = React.useMemo(
		() => (series === undefined ? [] : series.map((p) => ({ value: p.errorRate }))),
		[series],
	)
	const delta = baselineDelta(service.p95LatencyMs, baseline)
	const goToDetail = () =>
		navigate({
			to: "/services/$serviceName",
			params: { serviceName: service.serviceName },
			search: serviceDetailSearch(filters, service.environment),
		})

	return (
		<TableRow
			className={cn(
				"cursor-pointer border-l-2 border-l-transparent hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				health === "unhealthy" && "border-l-destructive",
			)}
			tabIndex={0}
			onClick={goToDetail}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					goToDetail()
				}
			}}
		>
			<TableCell>
				<Link
					to="/services/$serviceName"
					params={{ serviceName: service.serviceName }}
					search={serviceDetailSearch(filters, service.environment)}
					className="flex max-w-full items-center gap-1.5 font-medium text-primary hover:underline"
					onClick={(e) => e.stopPropagation()}
					title={service.serviceName}
				>
					<ServiceDot serviceName={service.serviceName} />
					<span className="min-w-0 truncate">{service.serviceName}</span>
					<HealthDot health={health} />
				</Link>
				{service.serviceNamespace ? (
					<div className="truncate text-xs text-muted-foreground">{service.serviceNamespace}</div>
				) : null}
			</TableCell>
			<TableCell className="hidden lg:table-cell font-mono text-xs">
				{formatLatency(service.p50LatencyMs)}
			</TableCell>
			<TableCell className="font-mono text-xs">
				<div>{formatLatency(service.p95LatencyMs)}</div>
				{delta !== undefined && (
					<div className={cn("text-[10px] tabular-nums", delta.className)}>{delta.label}</div>
				)}
			</TableCell>
			<TableCell className="hidden lg:table-cell font-mono text-xs">
				{formatLatency(service.p99LatencyMs)}
			</TableCell>
			<TableCell>
				<div
					className="relative h-8 w-full max-w-[120px]"
					role="img"
					aria-label={`Error rate: ${formatErrorRate(service.errorRate)}`}
				>
					<Sparkline
						data={errorRateData}
						color="var(--color-destructive, #ef4444)"
						className="absolute inset-0 h-full w-full"
					/>
					<div className="absolute inset-0 flex items-center justify-center">
						<span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
							{formatErrorRate(service.errorRate)}
						</span>
					</div>
				</div>
			</TableCell>
			<TableCell className="hidden md:table-cell">
				<Tooltip>
					<TooltipTrigger
						className="relative block h-8 w-full max-w-[120px]"
						aria-label={`Throughput: ${formatThroughput(service.throughput)}`}
					>
						<Sparkline
							data={throughputData}
							color="var(--color-primary, #3b82f6)"
							className="absolute inset-0 h-full w-full"
						/>
						<div className="absolute inset-0 flex flex-col items-center justify-center">
							<span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
								{service.hasSampling ? "~" : ""}
								{formatThroughput(service.throughput)}
							</span>
							{service.hasSampling && (
								<span className="font-mono text-[9px] text-muted-foreground [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
									~{formatThroughput(service.tracedThroughput)} traced
								</span>
							)}
						</div>
					</TooltipTrigger>
					{service.hasSampling && (
						<TooltipContent side="bottom">
							<p>
								Estimated from {((1 / service.samplingWeight) * 100).toFixed(0)}% sampled traces
								(x{service.samplingWeight.toFixed(0)} extrapolation)
							</p>
						</TooltipContent>
					)}
				</Tooltip>
			</TableCell>
			<TableCell className="hidden lg:table-cell text-center">
				{issueCount !== undefined && issueCount > 0 ? (
					<Badge
						variant="secondary"
						className={cn(
							"px-1.5 py-0 font-mono text-[10px] tabular-nums",
							health === "unhealthy" && "bg-destructive/15 text-severity-error",
						)}
					>
						{issueCount}
					</Badge>
				) : (
					<span className="text-xs text-muted-foreground">—</span>
				)}
			</TableCell>
			<TableCell className="hidden lg:table-cell">
				<DeployCell commits={service.commits} />
			</TableCell>
		</TableRow>
	)
})

interface ServicesTableProps {
	filters?: ServicesSearchParams
}

function LoadingState() {
	return (
		<div className="space-y-4">
			<div className="hidden rounded-md border overflow-auto md:block">
				<Table className="w-full table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>Service</TableHead>
							<TableHead className="w-[6%]">P50</TableHead>
							<TableHead className="w-[9%]">P95</TableHead>
							<TableHead className="w-[7%]">P99</TableHead>
							<TableHead className="w-[12%]">Error Rate</TableHead>
							<TableHead className="w-[12%]">Throughput</TableHead>
							<TableHead className="w-[7%]">Issues</TableHead>
							<TableHead className="w-[15%]">Last deploy</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{Array.from({ length: 5 }).map((_, i) => (
							<TableRow key={i}>
								<TableCell>
									<Skeleton className="h-4 w-32" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-12" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-14" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-12" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-8 w-full" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-8 w-full" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-8" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-24" />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div className="overflow-hidden rounded-md border md:hidden">
				{Array.from({ length: 5 }).map((_, i) => (
					<div
						key={i}
						className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0"
					>
						<div className="min-w-0 flex-1 space-y-1.5">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-3 w-24" />
						</div>
						<Skeleton className="h-4 w-12" />
					</div>
				))}
			</div>
		</div>
	)
}

export function ServicesTable({ filters }: ServicesTableProps) {
	const navigate = useNavigate()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		filters?.startTime,
		filters?.endTime,
		filters?.timePreset ?? "12h",
	)

	const overviewResult = useRefreshableAtomValue(
		getServiceOverviewResultAtom({
			data: {
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments: filters?.environments,
				commitShas: filters?.commitShas,
			},
		}),
	)

	const timeSeriesResult = useRefreshableAtomValue(
		getCustomChartServiceSparklinesResultAtom({
			data: {
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments: filters?.environments,
				commitShas: filters?.commitShas,
			},
		}),
	)

	const healthFilter = filters?.health
	// Kept in the blocking Result.all below so the health lane never flashes
	// from "healthy" to "unhealthy" after first paint; the derivation itself
	// lives in useServiceHealthSummary (shared with the filter sidebar).
	const { result: incidentsResult } = useAlertIncidentsList()
	const anomaliesResult = useAtomValue(openAnomalyIncidentsAtom)
	const healthSummary = useServiceHealthSummary({
		startTime: effectiveStartTime,
		endTime: effectiveEndTime,
		environments: filters?.environments,
		commitShas: filters?.commitShas,
	})

	// Progressive enrichment — neither blocks first paint. The baseline payload
	// is hour-snapped upstream, so this atom refetches at most hourly; issue
	// counts are one cheap Postgres GROUP BY.
	const baselineResult = useAtomValue(
		getServiceHealthBaselineResultAtom({
			data: {
				rangeStartTime: effectiveStartTime,
				environments: filters?.environments,
			},
		}),
	)
	const issueCountsResult = useAtomValue(openIssueCountsAtom)

	const baselineData = Result.isSuccess(baselineResult) ? baselineResult.value : undefined
	const baselineMap = React.useMemo(
		() => (baselineData === undefined ? undefined : buildBaselineMap(baselineData.data)),
		[baselineData],
	)
	const issueCountsData = Result.isSuccess(issueCountsResult) ? issueCountsResult.value : undefined
	const issueCountByService = React.useMemo(() => {
		if (issueCountsData === undefined) return undefined
		return new Map(issueCountsData.data.map((row) => [row.service_name, row.open_count]))
	}, [issueCountsData])

	return Result.builder(Result.all([overviewResult, timeSeriesResult, anomaliesResult, incidentsResult]))
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess(([overviewResponse, timeSeriesResponse], combinedResult) => {
			const timeSeriesMap = timeSeriesResponse.data
			const healthFor = (service: ServiceOverview) =>
				healthSummary?.byRow.get(serviceHealthRowKey(service.serviceName, service.environment))
			const services = healthFilter
				? overviewResponse.data.filter((service) => healthFor(service) === healthFilter)
				: overviewResponse.data

			const groups = groupByEnvironment(services)

			// Tally over the DISPLAYED rows so the footer agrees with the table
			// under active filters.
			let unhealthyCount = 0
			let degradedCount = 0
			for (const service of services) {
				const health = healthFor(service)
				if (health === "unhealthy") unhealthyCount += 1
				else if (health === "degraded") degradedCount += 1
			}

			const rowFor = (service: ServiceOverview) => {
				const serviceSeries = Object.hasOwn(timeSeriesMap, service.serviceName)
					? timeSeriesMap[service.serviceName]
					: undefined
				return (
					<ServiceRow
						key={`${service.serviceName}-${service.serviceNamespace}-${service.environment}`}
						service={service}
						series={Array.isArray(serviceSeries) ? serviceSeries : undefined}
						filters={filters}
						health={healthFor(service)}
						baseline={baselineMap?.get(
							baselineKey(service.serviceName, service.serviceNamespace, service.environment),
						)}
						issueCount={issueCountByService?.get(service.serviceName)}
						navigate={navigate}
					/>
				)
			}

			return (
				<div
					className={`space-y-4 transition-opacity ${combinedResult.waiting ? "opacity-60" : ""}`}
				>
					{/* Desktop: full metrics table. Below md the fixed-width columns and
				    in-cell sparklines force horizontal scroll, so we swap to a list. */}
					<div className="hidden md:block rounded-md border overflow-auto">
						{/* Fixed layout: the metric columns keep their set widths and the
						    Service column absorbs whatever remains, truncating long names —
						    so the table always fits the viewport instead of scrolling
						    horizontally. */}
						<Table aria-label="Services" className="w-full table-fixed">
							<TableHeader>
								<TableRow>
									{/* Explicit width so the fixed layout scales every column
									    proportionally — leaving Service auto would let the fixed
									    metric columns squeeze it to nothing on narrow viewports. */}
									<TableHead>Service</TableHead>
									<TableHead className="hidden lg:table-cell w-[6%]">P50</TableHead>
									<TableHead className="w-[9%]">P95</TableHead>
									<TableHead className="hidden lg:table-cell w-[7%]">P99</TableHead>
									<TableHead className="w-[12%]">Error Rate</TableHead>
									<TableHead className="hidden md:table-cell w-[12%]">
										Throughput
									</TableHead>
									<TableHead className="hidden lg:table-cell w-[7%] text-center">
										Issues
									</TableHead>
									<TableHead className="hidden lg:table-cell w-[15%]">
										Last deploy
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{services.length === 0 ? (
									<TableRow>
										<TableCell colSpan={8} className="h-24 text-center">
											No services found
										</TableCell>
									</TableRow>
								) : (
									groups.map(([environment, envServices]) => (
										<React.Fragment key={environment}>
											<TableRow className="bg-muted/30 hover:bg-muted/30">
												<TableCell colSpan={8} className="py-2">
													<div className="flex items-center gap-2">
														<EnvironmentBadge environment={environment} />
														<span className="text-xs text-muted-foreground">
															{envServices.length}{" "}
															{envServices.length === 1
																? "service"
																: "services"}
														</span>
													</div>
												</TableCell>
											</TableRow>
											{envServices.map(rowFor)}
										</React.Fragment>
									))
								)}
							</TableBody>
						</Table>
					</div>

					{/* Mobile: stacked, tap-to-drill list. Grouped by environment to
				    match the desktop table; metrics collapse to a tight mono line. */}
					<div className="overflow-hidden rounded-md border md:hidden">
						{services.length === 0 ? (
							<div className="p-6 text-center text-sm text-muted-foreground">
								No services found
							</div>
						) : (
							groups.map(([environment, envServices]) => (
								<div key={environment}>
									<div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
										<EnvironmentBadge environment={environment} />
										<span className="text-xs text-muted-foreground">
											{envServices.length}{" "}
											{envServices.length === 1 ? "service" : "services"}
										</span>
									</div>
									{envServices.map((service: ServiceOverview) => {
										const health = healthFor(service)
										return (
											<Link
												key={`${service.serviceName}-${service.serviceNamespace}-${service.environment}`}
												to="/services/$serviceName"
												params={{ serviceName: service.serviceName }}
												search={serviceDetailSearch(filters, service.environment)}
												className="flex min-h-11 items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
											>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5 text-sm font-medium text-primary">
														<ServiceDot serviceName={service.serviceName} />
														<span className="truncate">
															{service.serviceName}
														</span>
														<HealthDot health={health} />
													</div>
													{service.serviceNamespace ? (
														<div className="truncate text-xs text-muted-foreground">
															{service.serviceNamespace}
														</div>
													) : null}
													<div className="mt-1 flex items-center gap-3 font-mono text-xs tabular-nums">
														<span>
															<span className="text-muted-foreground/60">
																P99{" "}
															</span>
															<span className="text-foreground">
																{formatLatency(service.p99LatencyMs)}
															</span>
														</span>
														<span>
															<span className="text-muted-foreground/60">
																Thru{" "}
															</span>
															<span className="text-foreground">
																{service.hasSampling ? "~" : ""}
																{formatThroughput(service.throughput)}
															</span>
														</span>
													</div>
												</div>
												<div className="shrink-0 text-right">
													<div
														className={cn(
															"font-mono text-sm font-semibold tabular-nums",
															errorRateToneClass(service.errorRate),
														)}
													>
														{formatErrorRate(service.errorRate)}
													</div>
													<div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
														err
													</div>
												</div>
											</Link>
										)
									})}
								</div>
							))
						)}
					</div>

					<div className="flex items-center justify-between text-sm text-muted-foreground">
						<span>
							Showing {services.length} {healthFilter ?? ""}{" "}
							{services.length === 1 ? "service" : "services"}
						</span>
						{(unhealthyCount > 0 || degradedCount > 0) && (
							<span className="text-xs">
								{unhealthyCount > 0 ? `${unhealthyCount} unhealthy` : null}
								{unhealthyCount > 0 && degradedCount > 0 ? " · " : null}
								{degradedCount > 0 ? `${degradedCount} degraded` : null}
							</span>
						)}
					</div>
				</div>
			)
		})
		.render()
}
