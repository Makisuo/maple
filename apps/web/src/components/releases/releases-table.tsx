import React, { Fragment, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { VcsCommitDetailResponse } from "@maple/domain/http"

import { ChevronRightIcon } from "@/components/icons"
import { Result, useAtomValue } from "@/lib/effect-atom"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import {
	CommitAvatar,
	CommitShaHoverCard,
	commitsQueryAtom,
	commitsQueryKey,
	firstLine,
	isResolvableSha,
} from "@/components/vcs/commit-sha-hover-card"
import { ReleaseHealthPill, releaseHealthFigure } from "./release-health"
import {
	releaseDayLabel,
	shortReleaseLabel,
	type ReleaseGroup,
	type ReleaseServiceImpact,
} from "./release-model"

/** The bulk VCS lookup takes one page of shas; rows past it fall back to the sha. */
const COMMIT_RESOLVE_LIMIT = 50

const EMPTY_COMMITS: ReadonlyMap<string, VcsCommitDetailResponse> = new Map()

/**
 * Resolves the commits the table is about to render in ONE request, the way
 * the services table does. Never blocks paint: until it resolves, rows show
 * the short sha. Mounted only when there is at least one resolvable sha — an
 * empty key would send a request the endpoint rejects.
 */
function ResolvedCommits({
	shasKey,
	children,
}: {
	shasKey: string
	children: (commits: ReadonlyMap<string, VcsCommitDetailResponse>) => React.ReactNode
}) {
	const result = useAtomValue(commitsQueryAtom(shasKey))
	const commits = useMemo(
		() =>
			Result.isSuccess(result)
				? new Map(result.value.commits.map((commit) => [commit.sha, commit]))
				: EMPTY_COMMITS,
		[result],
	)
	return <>{children(commits)}</>
}

interface DeltaProps {
	value: number
	baseline: number | undefined
	format: (value: number) => string
	/** Tone of the live figure when the band trips; the baseline stays muted. */
	tone?: "error" | "warn"
}

/** "1.24% vs 0.30%" — the live figure, then the rest of the service beside it. */
function Delta({ value, baseline, format, tone }: DeltaProps) {
	return (
		<span className="inline-flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
			<span
				className={cn(
					tone === "error" && "text-severity-error",
					tone === "warn" && "text-severity-warn",
				)}
			>
				{format(value)}
			</span>
			{baseline !== undefined ? (
				<span
					className="text-[10px] text-muted-foreground/70"
					title="Every other version of this service in this window"
				>
					vs {format(baseline)}
				</span>
			) : null}
		</span>
	)
}

function ServiceChips({ services }: { services: ReadonlyArray<ReleaseServiceImpact> }) {
	// One chip per service: a commit on two environments of one service is
	// still one service, and the expanded rows carry the environment.
	const names = [...new Set(services.map((service) => service.serviceName))]
	const shown = names.slice(0, 3)
	const more = names.length - shown.length
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			{shown.map((serviceName) => (
				<span
					key={serviceName}
					className="inline-flex items-center gap-1 text-xs text-muted-foreground"
				>
					<ServiceDot serviceName={serviceName} />
					{serviceName}
				</span>
			))}
			{more > 0 ? <span className="text-[11px] text-muted-foreground/70">+{more}</span> : null}
		</span>
	)
}

interface ReleaseTitleProps {
	commitSha: string
	commit: VcsCommitDetailResponse | undefined
	health: ReleaseServiceImpact["health"]
	figure: string | undefined
}

/** Message-first title: subject · pill, with sha · author demoted underneath. */
function ReleaseTitle({ commitSha, commit, health, figure }: ReleaseTitleProps) {
	const resolvable = isResolvableSha(commitSha)
	const author = commit?.authorLogin ?? commit?.authorName ?? undefined
	return (
		<div className="flex min-w-0 items-start gap-2.5">
			<div className="mt-0.5 shrink-0">
				{commit ? (
					<CommitAvatar url={commit.authorAvatarUrl} name={author ?? "Unknown author"} compact />
				) : (
					<span className="block size-5 rounded-full bg-muted" />
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-0.5 leading-tight">
				<div className="flex min-w-0 items-center gap-2">
					<CommitShaHoverCard
						sha={commitSha}
						className={cn(
							"min-w-0 truncate text-[13px] text-foreground",
							commit === undefined && "font-mono text-xs",
						)}
					>
						{commit ? firstLine(commit.message) : shortReleaseLabel(commitSha)}
					</CommitShaHoverCard>
					{health === "healthy" ? null : <ReleaseHealthPill health={health} label={figure} />}
				</div>
				<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					{commit ? <span className="font-mono">{shortReleaseLabel(commitSha)}</span> : null}
					{author ? <span className="truncate">{author}</span> : null}
					{!commit && !resolvable ? <span>deployment reference</span> : null}
				</div>
			</div>
		</div>
	)
}

interface ReleasesTableProps {
	groups: ReadonlyArray<ReleaseGroup>
	timeSearch: TimeRangeSearch
	environments?: string[]
	waiting?: boolean
}

/**
 * Grouped by commit with expandable per-service children, day headers instead
 * of a date column, and deltas against the rest of each service.
 */
export function ReleasesTable(props: ReleasesTableProps) {
	const shasKey = useMemo(
		() => commitsQueryKey(props.groups.slice(0, COMMIT_RESOLVE_LIMIT).map((group) => group.commitSha)),
		[props.groups],
	)
	if (shasKey === "") return <ReleasesTableRows {...props} commits={EMPTY_COMMITS} />
	return (
		<ResolvedCommits shasKey={shasKey}>
			{(commits) => <ReleasesTableRows {...props} commits={commits} />}
		</ResolvedCommits>
	)
}

function ReleasesTableRows({
	groups,
	timeSearch,
	environments,
	waiting,
	commits,
}: ReleasesTableProps & { commits: ReadonlyMap<string, VcsCommitDetailResponse> }) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
	const nowMs = Date.now()

	const toggle = (sha: string) =>
		setExpanded((current) => {
			const next = new Set(current)
			if (next.has(sha)) next.delete(sha)
			else next.add(sha)
			return next
		})

	const linkSearch = (service: string, environment: string) => ({
		service,
		environments: environments ?? (environment ? [environment] : undefined),
		...timeSearch,
	})

	let lastDay: string | undefined

	return (
		<div className={cn("rounded-md border bg-card transition-opacity", waiting && "opacity-60")}>
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="w-[38%] min-w-[260px]">Release</TableHead>
						<TableHead>Services</TableHead>
						<TableHead className="whitespace-nowrap">First seen</TableHead>
						<TableHead className="text-right">Traffic</TableHead>
						<TableHead>Error rate</TableHead>
						<TableHead>p95</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{groups.map((group) => {
						const day = releaseDayLabel(group.firstSeen, nowMs)
						const showDay = day !== lastDay
						lastDay = day
						const primary = group.services[0]!
						const isOpen = expanded.has(group.commitSha)
						const worst =
							group.services.find((service) => service.health === group.health) ?? primary
						return (
							<Fragment key={group.commitSha}>
								{showDay ? (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={6}
											className="bg-muted/40 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
										>
											{day}
										</TableCell>
									</TableRow>
								) : null}
								<TableRow className="group/row">
									<TableCell className="py-2">
										<div className="flex items-start gap-1">
											<button
												type="button"
												aria-expanded={isOpen}
												aria-label={isOpen ? "Hide services" : "Show services"}
												onClick={() => toggle(group.commitSha)}
												className={cn(
													"mt-1 shrink-0 rounded p-0.5 text-muted-foreground/60 transition-transform hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
													isOpen && "rotate-90",
													group.services.length <= 1 && "invisible",
												)}
											>
												<ChevronRightIcon size={12} />
											</button>
											<Link
												to="/releases/$commitSha"
												params={{ commitSha: group.commitSha }}
												search={linkSearch(worst.serviceName, worst.environment)}
												className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
											>
												<ReleaseTitle
													commitSha={group.commitSha}
													commit={commits.get(group.commitSha)}
													health={group.health}
													figure={releaseHealthFigure(worst)}
												/>
											</Link>
										</div>
									</TableCell>
									<TableCell className="py-2 align-top">
										<ServiceChips services={group.services} />
									</TableCell>
									<TableCell
										className="whitespace-nowrap py-2 align-top font-mono text-xs tabular-nums text-muted-foreground"
										title={new Date(group.firstSeen).toLocaleString()}
									>
										{formatRelativeTimeOrDate(group.firstSeen)}
									</TableCell>
									<TableCell className="py-2 text-right align-top font-mono text-xs tabular-nums">
										{formatNumber(group.spanCount)}
									</TableCell>
									<TableCell className="py-2 align-top">
										<Delta
											value={worst.errorRate}
											baseline={
												group.services.length === 1
													? worst.baseline?.errorRate
													: undefined
											}
											format={formatErrorRate}
											tone={group.health === "regressed" ? "error" : undefined}
										/>
									</TableCell>
									<TableCell className="py-2 align-top">
										<Delta
											value={worst.p95LatencyMs}
											baseline={
												group.services.length === 1
													? worst.baseline?.p95LatencyMs
													: undefined
											}
											format={formatLatency}
											tone={group.health === "watch" ? "warn" : undefined}
										/>
									</TableCell>
								</TableRow>
								{isOpen
									? group.services.map((service) => (
											<TableRow
												key={`${service.serviceName}:${service.environment}`}
												className="bg-muted/20"
											>
												<TableCell className="py-1.5 pl-12">
													<Link
														to="/releases/$commitSha"
														params={{ commitSha: group.commitSha }}
														search={linkSearch(
															service.serviceName,
															service.environment,
														)}
														className="inline-flex items-center gap-2 text-xs hover:underline"
													>
														<ServiceDot serviceName={service.serviceName} />
														{service.serviceName}
														{service.environment && !environments?.length ? (
															<span className="text-muted-foreground/70">
																{service.environment}
															</span>
														) : null}
														{service.health === "healthy" ? null : (
															<ReleaseHealthPill
																health={service.health}
																label={releaseHealthFigure(service)}
															/>
														)}
													</Link>
												</TableCell>
												<TableCell className="py-1.5" />
												<TableCell
													className="whitespace-nowrap py-1.5 font-mono text-xs tabular-nums text-muted-foreground"
													title={new Date(service.firstSeen).toLocaleString()}
												>
													{formatRelativeTimeOrDate(service.firstSeen)}
												</TableCell>
												<TableCell className="py-1.5 text-right font-mono text-xs tabular-nums">
													{formatNumber(service.spanCount)}
												</TableCell>
												<TableCell className="py-1.5">
													<Delta
														value={service.errorRate}
														baseline={service.baseline?.errorRate}
														format={formatErrorRate}
														tone={
															service.health === "regressed"
																? "error"
																: undefined
														}
													/>
												</TableCell>
												<TableCell className="py-1.5">
													<Delta
														value={service.p95LatencyMs}
														baseline={service.baseline?.p95LatencyMs}
														format={formatLatency}
														tone={service.health === "watch" ? "warn" : undefined}
													/>
												</TableCell>
											</TableRow>
										))
									: null}
							</Fragment>
						)
					})}
				</TableBody>
			</Table>
		</div>
	)
}
