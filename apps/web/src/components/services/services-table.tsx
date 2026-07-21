import React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Link, useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useAlertIncidentsList } from "@/hooks/use-alerts-list"
import { deriveServiceHealthFromCauses, type ServiceHealthCause } from "@/components/dashboard/service-health"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { Tooltip, TooltipTrigger, TooltipContent } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"
import { formatErrorRate } from "@maple/ui/lib/format"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { QueryErrorState } from "@/components/common/query-error-state"
import { type ServiceOverview, type CommitBreakdown } from "@/api/warehouse/services"
import {
	getCustomChartServiceSparklinesResultAtom,
	getServiceOverviewResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { openAnomalyIncidentsAtom } from "@/lib/services/atoms/anomaly-atoms"
import type { ServicesSearchParams } from "@/routes/services/index"
import { ServiceDot } from "@maple/ui/components/service-dot"

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

function CommitsList({ commits }: { commits: CommitBreakdown[] }) {
	if (commits.length === 0) {
		return <span className="text-muted-foreground">N/A</span>
	}

	if (commits.length === 1) {
		const sha = commits[0].commitSha
		return (
			<CommitShaHoverCard sha={sha} className="font-mono">
				{truncateCommitSha(sha)}
			</CommitShaHoverCard>
		)
	}

	// Several versions served traffic: keep the row ONE line — the dominant
	// commit (hover-resolvable) plus a "+N" chip whose tooltip holds the full
	// breakdown. Rendering every sha inline stacked the cell several rows tall
	// and made the table unreadable for services mid-rollout.
	const ordered = commits.toSorted((a, b) => b.percentage - a.percentage)
	const [dominant, ...rest] = ordered
	return (
		<div className="flex items-center gap-1">
			<CommitShaHoverCard sha={dominant.commitSha} className="font-mono">
				{truncateCommitSha(dominant.commitSha)}
			</CommitShaHoverCard>
			<Badge variant="secondary" className="px-1 py-0 text-[10px] leading-tight">
				{dominant.percentage}%
			</Badge>
			<Tooltip>
				<TooltipTrigger
					className="cursor-default rounded bg-muted px-1 py-0 font-mono text-[10px] leading-tight text-muted-foreground"
					aria-label={`${rest.length} more versions`}
				>
					+{rest.length}
				</TooltipTrigger>
				<TooltipContent side="left" className="p-2">
					<div className="flex flex-col gap-1">
						{rest.map((c) => (
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
		</div>
	)
}

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
							<TableHead className="w-[8%]">P50</TableHead>
							<TableHead className="w-[8%]">P95</TableHead>
							<TableHead className="w-[8%]">P99</TableHead>
							<TableHead className="w-[14%]">Error Rate</TableHead>
							<TableHead className="w-[14%]">Throughput</TableHead>
							<TableHead className="w-[16%]">Commit</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{Array.from({ length: 5 }).map((_, i) => (
							<TableRow key={i}>
								<TableCell>
									<Skeleton className="h-4 w-32" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-14" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-14" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-14" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-8 w-full" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-8 w-full" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-4 w-16" />
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
	const { result: incidentsResult } = useAlertIncidentsList()
	const anomaliesResult = useAtomValue(openAnomalyIncidentsAtom)

	return Result.builder(Result.all([overviewResult, timeSeriesResult, anomaliesResult, incidentsResult]))
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess(
			(
				[overviewResponse, timeSeriesResponse, anomaliesResponse, incidentsResponse],
				combinedResult,
			) => {
				const timeSeriesMap = timeSeriesResponse.data
				const openIncidents = incidentsResponse.incidents.filter(
					(incident) => incident.status === "open",
				)
				const services = healthFilter
					? overviewResponse.data.filter((service) => {
							const alertCauses: ServiceHealthCause[] = openIncidents
								.filter((incident) => incident.groupKey === service.serviceName)
								.map((incident) => ({ severity: incident.severity, label: "Alert firing" }))
							const anomalyCauses: ServiceHealthCause[] = anomaliesResponse.incidents
								.filter(
									(incident) =>
										incident.serviceName === service.serviceName &&
										incident.deploymentEnv === service.environment,
								)
								.map((incident) => ({ severity: incident.severity, label: "Anomaly" }))
							return (
								deriveServiceHealthFromCauses([...alertCauses, ...anomalyCauses]) ===
								healthFilter
							)
						})
					: overviewResponse.data

				const groups = groupByEnvironment(services)

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
										<TableHead className="hidden lg:table-cell w-[8%]">P50</TableHead>
										<TableHead className="hidden lg:table-cell w-[8%]">P95</TableHead>
										<TableHead className="w-[8%]">P99</TableHead>
										<TableHead className="w-[14%]">Error Rate</TableHead>
										<TableHead className="hidden md:table-cell w-[14%]">
											Throughput
										</TableHead>
										<TableHead className="hidden lg:table-cell w-[16%]">Commit</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{services.length === 0 ? (
										<TableRow>
											<TableCell colSpan={7} className="h-24 text-center">
												No services found
											</TableCell>
										</TableRow>
									) : (
										groups.map(([environment, envServices]) => (
											<React.Fragment key={environment}>
												<TableRow className="bg-muted/30 hover:bg-muted/30">
													<TableCell colSpan={7} className="py-2">
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
												{envServices.map((service: ServiceOverview) => {
													const serviceSeries = Object.hasOwn(
														timeSeriesMap,
														service.serviceName,
													)
														? timeSeriesMap[service.serviceName]
														: undefined
													const throughputData = Array.isArray(serviceSeries)
														? serviceSeries.map((p) => ({ value: p.throughput }))
														: []
													const errorRateData = Array.isArray(serviceSeries)
														? serviceSeries.map((p) => ({ value: p.errorRate }))
														: []

													return (
														<TableRow
															key={`${service.serviceName}-${service.serviceNamespace}-${service.environment}`}
															className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
															tabIndex={0}
															onClick={() =>
																navigate({
																	to: "/services/$serviceName",
																	params: {
																		serviceName: service.serviceName,
																	},
																	search: serviceDetailSearch(
																		filters,
																		service.environment,
																	),
																})
															}
															onKeyDown={(e) => {
																if (e.key === "Enter" || e.key === " ") {
																	e.preventDefault()
																	navigate({
																		to: "/services/$serviceName",
																		params: {
																			serviceName: service.serviceName,
																		},
																		search: serviceDetailSearch(
																			filters,
																			service.environment,
																		),
																	})
																}
															}}
														>
															<TableCell>
																<Link
																	to="/services/$serviceName"
																	params={{
																		serviceName: service.serviceName,
																	}}
																	search={serviceDetailSearch(
																		filters,
																		service.environment,
																	)}
																	className="flex max-w-full items-center gap-1.5 font-medium text-primary hover:underline"
																	onClick={(e) => e.stopPropagation()}
																	title={service.serviceName}
																>
																	<ServiceDot
																		serviceName={service.serviceName}
																	/>
																	<span className="min-w-0 truncate">
																		{service.serviceName}
																	</span>
																</Link>
																{service.serviceNamespace ? (
																	<div className="truncate text-xs text-muted-foreground">
																		{service.serviceNamespace}
																	</div>
																) : null}
															</TableCell>
															<TableCell className="hidden lg:table-cell font-mono text-xs">
																{formatLatency(service.p50LatencyMs)}
															</TableCell>
															<TableCell className="hidden lg:table-cell font-mono text-xs">
																{formatLatency(service.p95LatencyMs)}
															</TableCell>
															<TableCell className="font-mono text-xs">
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
																			{formatErrorRate(
																				service.errorRate,
																			)}
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
																				{service.hasSampling
																					? "~"
																					: ""}
																				{formatThroughput(
																					service.throughput,
																				)}
																			</span>
																			{service.hasSampling && (
																				<span className="font-mono text-[9px] text-muted-foreground [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
																					~
																					{formatThroughput(
																						service.tracedThroughput,
																					)}{" "}
																					traced
																				</span>
																			)}
																		</div>
																	</TooltipTrigger>
																	{service.hasSampling && (
																		<TooltipContent side="bottom">
																			<p>
																				Estimated from{" "}
																				{(
																					(1 /
																						service.samplingWeight) *
																					100
																				).toFixed(0)}
																				% sampled traces (x
																				{service.samplingWeight.toFixed(
																					0,
																				)}{" "}
																				extrapolation)
																			</p>
																		</TooltipContent>
																	)}
																</Tooltip>
															</TableCell>
															<TableCell className="hidden lg:table-cell font-mono text-xs text-muted-foreground">
																<CommitsList commits={service.commits} />
															</TableCell>
														</TableRow>
													)
												})}
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
										{envServices.map((service: ServiceOverview) => (
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
										))}
									</div>
								))
							)}
						</div>

						<div className="text-sm text-muted-foreground">
							Showing {services.length} {healthFilter ?? ""}{" "}
							{services.length === 1 ? "service" : "services"}
						</div>
					</div>
				)
			},
		)
		.render()
}
