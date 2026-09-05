import { useCallback, useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getReleaseDetailResultAtom, getReleasesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"
import { useCommitMarkers } from "@/components/vcs/commit-markers/use-commit-markers"
import type { ReleasePoint } from "@/components/vcs/commit-markers/marker-layout"
import {
	CommitAvatar,
	CommitShaHoverCard,
	commitQueryAtom,
	firstLine,
	isResolvableSha,
} from "@/components/vcs/commit-sha-hover-card"
import { ReleaseComparison, ReleaseVersionsRail } from "@/components/releases/release-detail-panels"
import { ReleaseIssuesPanel } from "@/components/releases/release-issues-panel"
import { ReleaseHealthPill, releaseHealthFigure } from "@/components/releases/release-health"
import { deriveReleaseImpacts, shortReleaseLabel } from "@/components/releases/release-model"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const DEFAULT_PRESET = "7d"

const releaseDetailSearchSchema = Schema.Struct({
	// The service whose version this page describes. A commit lands on many
	// services; without one the page offers the list of services it reached.
	service: Schema.optional(Schema.String),
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/releases/$commitSha")({
	component: ReleaseDetailPage,
	validateSearch: Schema.toStandardSchemaV1(releaseDetailSearchSchema),
})

interface ReleaseChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

// The service page's four golden-signal cards, so a release reads like the
// service it landed on.
const RELEASE_CHARTS: ReleaseChartConfig[] = [
	{
		id: "latency",
		chartId: "latency-line",
		title: "Latency",
		layout: { x: 0, y: 0, w: 6, h: 4 },
		legend: "visible",
		tooltip: "visible",
	},
	{
		id: "throughput",
		chartId: "throughput-area",
		title: "Throughput",
		layout: { x: 6, y: 0, w: 6, h: 4 },
		tooltip: "visible",
		rateMode: "per_second",
	},
	{
		id: "apdex",
		chartId: "apdex-area",
		title: "Apdex",
		layout: { x: 0, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
	{
		id: "error-rate",
		chartId: "error-rate-area",
		title: "Error Rate",
		layout: { x: 6, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
]

const EMPTY_RELEASES: ReadonlyArray<ReleasePoint> = []

function ReleaseDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<ReleaseDetailContent />
		</PageRefreshProvider>
	)
}

/** Commit message as the page title once the sha resolves; the short sha until then. */
function ReleaseTitle({ commitSha }: { commitSha: string }) {
	if (!isResolvableSha(commitSha)) {
		return <span className="truncate font-mono">{commitSha}</span>
	}
	return <ResolvedReleaseTitle commitSha={commitSha} />
}

function ResolvedReleaseTitle({ commitSha }: { commitSha: string }) {
	const result = useAtomValue(commitQueryAtom(commitSha))
	return Result.builder(result)
		.onSuccess((commit) => (
			<span className="flex min-w-0 items-center gap-2.5">
				<CommitAvatar
					url={commit.authorAvatarUrl}
					name={commit.authorLogin ?? commit.authorName ?? "Unknown author"}
				/>
				<span className="truncate">{firstLine(commit.message)}</span>
			</span>
		))
		.orElse(() => <span className="truncate font-mono">{shortReleaseLabel(commitSha)}</span>)
}

/** Author · repo · sha, plus the link out to the provider. */
function ReleaseMeta({ commitSha }: { commitSha: string }) {
	const resolvable = isResolvableSha(commitSha)
	if (!resolvable) return <span>deployment reference</span>
	return <ResolvedReleaseMeta commitSha={commitSha} />
}

function ResolvedReleaseMeta({ commitSha }: { commitSha: string }) {
	const result = useAtomValue(commitQueryAtom(commitSha))
	return Result.builder(result)
		.onSuccess((commit) => (
			<>
				<span className="truncate">
					{commit.authorLogin ?? commit.authorName ?? "Unknown author"}
				</span>
				<span className="truncate text-muted-foreground/70">{commit.repoFullName}</span>
				<a
					href={commit.htmlUrl}
					target="_blank"
					rel="noreferrer"
					className="font-mono text-primary hover:underline"
				>
					{shortReleaseLabel(commitSha)} ↗
				</a>
			</>
		))
		.orElse(() => (
			<CommitShaHoverCard sha={commitSha} className="font-mono">
				{shortReleaseLabel(commitSha)}
			</CommitShaHoverCard>
		))
}

function ReleaseDetailContent() {
	const { commitSha } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)

	const handleTimeChange = useCallback(
		(
			range: { startTime?: string; endTime?: string; presetValue?: string },
			options?: { replace?: boolean },
		) => {
			navigate({
				replace: options?.replace,
				search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
			})
		},
		[navigate],
	)

	const timeSearch = pickTimeRangeSearch(search)
	const service = search.service

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Releases", href: "/releases" }, { label: shortReleaseLabel(commitSha) }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<PageLayout.Title
									className="flex min-w-0 items-center gap-2.5"
									title={commitSha}
								>
									<ReleaseTitle commitSha={commitSha} />
								</PageLayout.Title>
							}
						>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
								{service ? (
									<Button
										variant="outline"
										size="sm"
										render={
											<Link
												to="/services/$serviceName"
												params={{ serviceName: service }}
												search={{ ...timeSearch, environments: search.environments }}
											/>
										}
									>
										<ServiceDot serviceName={service} />
										{service}
									</Button>
								) : null}
								<TimeRangeHeaderControls
									startTime={search.startTime}
									endTime={search.endTime}
									presetValue={
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									presets={LONG_RANGE_PRESET_OPTIONS}
									maxRangeSeconds={ONE_YEAR_SECONDS}
									onTimeChange={handleTimeChange}
								/>
							</div>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{service === undefined ? (
							<PickService
								commitSha={commitSha}
								startTime={startTime}
								endTime={endTime}
								environments={search.environments}
							/>
						) : (
							<ReleaseBody
								commitSha={commitSha}
								serviceName={service}
								startTime={startTime}
								endTime={endTime}
								environments={search.environments}
							/>
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

interface ScopedProps {
	commitSha: string
	startTime: string
	endTime: string
	environments?: string[]
}

/** A deep link without a service: list the services this commit reached in the window. */
function PickService({ commitSha, startTime, endTime, environments }: ScopedProps) {
	const search = Route.useSearch()
	const result = useAtomValue(getReleasesResultAtom({ data: { startTime, endTime, environments } }))
	const services = Result.builder(result)
		.onSuccess((response) =>
			[
				...new Set(
					response.releases
						.filter((row) => row.commitSha === commitSha)
						.map((row) => row.serviceName),
				),
			].toSorted(),
		)
		.orElse(() => undefined)

	if (services === undefined) return <Skeleton className="h-24 w-full rounded-md" />
	return (
		<div className="rounded-md border bg-card p-4 text-sm">
			<div className="mb-2 text-muted-foreground">
				{services.length === 0
					? "This version served no traffic in the window. Widen the time range, or pick the service it was deployed to."
					: "Pick the service to describe this version for:"}
			</div>
			<div className="flex flex-wrap gap-2">
				{services.map((serviceName) => (
					<Link
						key={serviceName}
						to="/releases/$commitSha"
						params={{ commitSha }}
						search={{ ...pickTimeRangeSearch(search), environments, service: serviceName }}
						className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
					>
						<ServiceDot serviceName={serviceName} />
						{serviceName}
					</Link>
				))}
			</div>
		</div>
	)
}

type Series = "version" | "others"

function ReleaseBody({
	commitSha,
	serviceName,
	startTime,
	endTime,
	environments,
}: ScopedProps & { serviceName: string }) {
	const search = Route.useSearch()
	const atom = getReleaseDetailResultAtom({
		data: { serviceName, commitSha, startTime, endTime, environments },
	})
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	const [series, setSeries] = useState<Series>("version")

	const derived = useMemo(() => {
		if (!Result.isSuccess(result)) return undefined
		const response = result.value
		const impacts = deriveReleaseImpacts(response.versions, response.timeline)
		// Several environments may answer when the page is unscoped; describe the busiest.
		const impact = impacts
			.filter((candidate) => candidate.commitSha === commitSha)
			.toSorted((a, b) => b.spanCount - a.spanCount)[0]
		const releases: ReleasePoint[] = response.timeline
			.filter((point) => point.serviceName === serviceName)
			.map((point) => ({
				bucket: point.bucket,
				commitSha: point.commitSha,
				count: point.count,
			}))
		return { response, impacts, impact, releases }
	}, [result, commitSha, serviceName])

	const points =
		derived === undefined
			? []
			: series === "version"
				? derived.response.points
				: derived.response.baselinePoints
	const detailPoints = useMemo(() => points.map((point) => ({ ...point })), [points])
	const chartBuckets = useMemo(() => detailPoints.map((point) => String(point.bucket)), [detailPoints])
	const commitMarkers = useCommitMarkers(derived?.releases ?? EMPTY_RELEASES, chartBuckets)
	const isLoading = Result.isInitial(result)
	const metrics = useMemo(
		() =>
			RELEASE_CHARTS.map((chart) => ({
				id: chart.id,
				chartId: chart.chartId,
				title: chart.title,
				layout: chart.layout,
				data: detailPoints,
				legend: chart.legend,
				tooltip: chart.tooltip,
				rateMode: chart.rateMode,
				isLoading,
			})),
		[detailPoints, isLoading],
	)

	if (Result.isFailure(result)) {
		return (
			<QueryErrorState error={result.cause} titleOverride="Failed to load release" onRetry={refresh} />
		)
	}
	if (derived === undefined) {
		return (
			<div className="flex flex-col gap-3">
				<Skeleton className="h-4 w-80" />
				<div className="grid gap-3 lg:grid-cols-2">
					<Skeleton className="h-56 rounded-md" />
					<Skeleton className="h-56 rounded-md" />
				</div>
				<Skeleton className="h-72 rounded-md" />
			</div>
		)
	}

	const { impact, impacts, response } = derived
	const timeSearch = pickTimeRangeSearch(search)
	const waiting = Result.isSuccess(result) && result.waiting

	if (impact === undefined) {
		return (
			<div className="flex flex-col gap-3">
				<div className="rounded-md border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
					<span className="font-mono">{shortReleaseLabel(commitSha)}</span> served no traffic on{" "}
					{serviceName} in this window. Widen the time range to include its deploy.
				</div>
				<ReleaseVersionsRail
					impacts={impacts}
					currentSha={commitSha}
					serviceName={serviceName}
					environments={environments}
					timeSearch={timeSearch}
				/>
			</div>
		)
	}

	const figure = releaseHealthFigure(impact)

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-xs text-muted-foreground">
				<ReleaseMeta commitSha={commitSha} />
				<span>
					first seen{" "}
					<span className="text-foreground" title={new Date(impact.firstSeen).toLocaleString()}>
						{formatRelativeTimeOrDate(impact.firstSeen)}
					</span>{" "}
					on {serviceName}
				</span>
				{impact.environment ? <span>{impact.environment}</span> : null}
				{impact.share !== undefined ? (
					<span>{Math.round(impact.share * 100)}% of the latest traffic</span>
				) : null}
				{impact.health === "healthy" ? null : (
					<ReleaseHealthPill health={impact.health} label={figure} />
				)}
			</div>

			<div className="grid gap-3 lg:grid-cols-2">
				<ReleaseComparison impact={impact} />
				<ReleaseVersionsRail
					impacts={impacts}
					currentSha={commitSha}
					serviceName={serviceName}
					environments={environments}
					timeSearch={timeSearch}
				/>
			</div>

			<div className="flex items-center justify-between gap-3">
				<Tabs
					value={series}
					onValueChange={(value) => setSeries(value === "others" ? "others" : "version")}
				>
					<TabsList variant="default" className="h-7 gap-0 p-0.5">
						<TabsTrigger
							value="version"
							className="h-6 px-2.5 text-xs font-medium sm:h-6 sm:text-xs"
						>
							This version
						</TabsTrigger>
						<TabsTrigger
							value="others"
							className="h-6 px-2.5 text-xs font-medium sm:h-6 sm:text-xs"
						>
							Other versions
						</TabsTrigger>
					</TabsList>
				</Tabs>
				<span className="text-[11px] text-muted-foreground/70">
					{series === "version"
						? `Only spans that carried ${shortReleaseLabel(commitSha)}`
						: `Every other version of ${serviceName} in the window`}
				</span>
			</div>
			<MetricsGrid
				items={metrics}
				waiting={!!waiting}
				syncId={`release-${commitSha}`}
				overlay={commitMarkers}
				yAxisWidth={72}
			/>

			<ReleaseIssuesPanel
				serviceName={serviceName}
				releaseFirstSeen={impact.firstSeen}
				fingerprints={response.errorFingerprints}
			/>
		</div>
	)
}
