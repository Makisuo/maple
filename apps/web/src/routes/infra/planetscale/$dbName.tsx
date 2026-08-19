import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"

import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PlanetScaleIcon } from "@/components/icons"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { PlanetScaleAlertMenu } from "@/components/infra/planetscale/planetscale-alert-menu"
import { PlanetScaleBranchScope } from "@/components/infra/planetscale/branch-scope"
import {
	PlanetScaleBranchBreakdownPanel,
	PlanetScaleBranchBreakdownPanelLoading,
} from "@/components/infra/planetscale/planetscale-branch-breakdown-panel"
import { PlanetScaleFilterChips } from "@/components/infra/planetscale/planetscale-filter-chips"
import { PlanetScaleFilterSidebar } from "@/components/infra/planetscale/planetscale-filter-sidebar"
import {
	applyBranchFilters,
	filtersFromSearch,
	planetscaleFilterSearchFields,
	soleSelectedBranch,
	toggleFilterValue,
	type PlanetScaleFilters,
} from "@/components/infra/planetscale/filters"
import {
	PlanetScaleChart,
	PlanetScaleChartLoading,
	type PlanetScaleMetric,
} from "@/components/infra/planetscale/planetscale-chart"
import { PlanetScaleNotConnected } from "@/components/infra/planetscale/planetscale-not-connected"
import { PlanetScaleTopQueries } from "@/components/infra/planetscale/planetscale-top-queries"
import {
	BRANCH_ABSENCE_COPY,
	METRICS_PAUSED_MESSAGE,
	PlanetScaleMetricsNotice,
	PlanetScaleRevokedNotice,
} from "@/components/infra/planetscale/planetscale-absence"
import {
	absenceReason,
	mergeBranchCandidates,
	orderBranches,
	resolveSelectedBranch,
	type BranchCandidate,
} from "@/components/infra/planetscale/branch-selection"
import { PlanetScaleSetupState } from "@/components/infra/planetscale/planetscale-setup-state"
import {
	derivePlanetScaleSetup,
	metricsNeverCollected,
} from "@/components/integrations/planetscale-setup-steps"
import {
	PlanetScaleActivityFeed,
	PlanetScaleActivityFeedLoading,
} from "@/components/infra/planetscale/planetscale-activity-feed"
import { eventsToChartMarkers } from "@/components/infra/planetscale/planetscale-events"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	getPlanetScaleBranchStatsResultAtom,
	planetscaleEventsResultAtom,
	planetscaleInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { PlanetScaleInfraTimeseriesRow } from "@/api/warehouse/planetscale-infra"
import type { PlanetScaleBranchStat } from "@/api/warehouse/service-map"
import type { PlanetScaleEventEntry } from "@/api/warehouse/planetscale-infra"

const planetscaleDbSearchSchema = Schema.Struct({
	/**
	 * LEGACY. Superseded by `branches` (plural), which the sidebar, chips and
	 * breakdown all write. Decoded by `filtersFromSearch` as a one-element
	 * selection and never written back, so every link shared before the filter
	 * vocabulary existed still resolves to the branch its sender was looking at.
	 */
	branch: Schema.optional(Schema.String),
	...planetscaleFilterSearchFields,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/planetscale/$dbName")({
	component: PlanetScaleDatabasePage,
	validateSearch: Schema.toStandardSchemaV1(planetscaleDbSearchSchema),
})

/** Stable empty fallbacks — a fresh `[]` per render busts every downstream memo. */
const NO_BUCKETS: ReadonlyArray<PlanetScaleInfraTimeseriesRow> = []
const NO_BRANCH_STATS: ReadonlyArray<PlanetScaleBranchStat> = []
const NO_EVENTS: ReadonlyArray<PlanetScaleEventEntry> = []
const EMPTY_SELECTION: ReadonlyArray<string> = []

function PlanetScaleDatabasePage() {
	const { dbName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			// Spreads `prev`, so ?branch= survives a time-range change. Keep it that way.
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const filters = filtersFromSearch(search)

	/**
	 * Scope to exactly one branch (or clear). The sticky-header select and the
	 * unknown-branch reset both go through here; it writes the plural vocabulary
	 * and drops the legacy singular so the URL converges on one form.
	 */
	const selectBranch = (branch: string | undefined) => {
		navigate({
			search: (prev) => ({
				...prev,
				branch: undefined,
				branches: branch === undefined ? undefined : [branch],
			}),
		})
	}

	const setFilter = (key: keyof PlanetScaleFilters, values: ReadonlyArray<string> | undefined) => {
		navigate({
			// An emptied filter leaves the URL entirely rather than lingering as `?branches=`.
			search: (prev) => ({ ...prev, branch: undefined, [key]: values }),
		})
	}

	const toggleBranch = (branch: string) => {
		setFilter("branches", toggleFilterValue(filters.branches, branch))
	}

	const clearFilters = () => {
		navigate({
			// Clearing filters must preserve the time range — it is a different axis.
			search: (prev) => ({
				...prev,
				branch: undefined,
				branches: undefined,
				branchStates: undefined,
				branchRoles: undefined,
				branchContains: undefined,
			}),
		})
	}

	const statusResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	const inventoryResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "databases", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	const database = Result.builder(inventoryResult)
		.onSuccess((inventory) => inventory.databases.find((db) => db.name === dbName) ?? null)
		.orElse(() => null)

	const status = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)
	// No scrape has ever landed: the charts would all be empty and the branch
	// table all dashes, so the page leads with setup instead.
	const neverCollected = status !== null && status.connected && metricsNeverCollected(status)
	const setupSteps = status !== null ? derivePlanetScaleSetup(status, Date.now()).steps : []

	const branchStatsResult = useRetainedRefreshableResultValue(
		getPlanetScaleBranchStatsResultAtom({ data: { database: dbName, startTime, endTime } }),
	)
	const branchStats = Result.builder(branchStatsResult)
		.onSuccess((r) => r.branches)
		.orElse(() => NO_BRANCH_STATS)

	const candidates = useMemo(
		() =>
			orderBranches(
				mergeBranchCandidates(
					database?.branches ?? [],
					branchStats,
					status?.scrape_target?.include_branches ?? [],
					status?.scrape_target?.exclude_branches ?? [],
				),
			),
		[database, branchStats, status],
	)
	// The charts and Query Insights take one branch or the whole database, so a
	// multi-branch selection has no single scope — soleSelectedBranch returns null
	// rather than picking one, and branch-scope.tsx says so on screen.
	const sole = soleSelectedBranch(filters)
	const resolution = useMemo(() => resolveSelectedBranch(candidates, sole ?? undefined), [candidates, sole])
	const selectedBranch = resolution.kind === "resolved" ? resolution.branch : null
	// The tables and the breakdown narrow; the charts can't (see above).
	const filteredCandidates = useMemo(() => applyBranchFilters(candidates, filters), [candidates, filters])

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "PlanetScale", href: "/infra/planetscale" },
						{ label: dbName },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<PlanetScaleFilterSidebar
							candidates={candidates}
							filters={filters}
							onFilterChange={setFilter}
							onClear={clearFilters}
						/>
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<div className="flex items-center gap-2">
									{/* The page's two scope controls sit together: which branch, which window. */}
									<BranchScopeSelect
										candidates={candidates}
										selected={selectedBranch}
										onSelect={selectBranch}
									/>
									<TimeRangeHeaderControls
										startTime={search.startTime ?? startTime}
										endTime={search.endTime ?? endTime}
										presetValue={
											search.timePreset ?? (search.startTime ? undefined : "12h")
										}
										onTimeChange={handleTimeChange}
									/>
								</div>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title={dbName}
									description="Branch-level health, live from PlanetScale."
									actions={
										database ? (
											<PlanetScaleAlertMenu
												database={dbName}
												kind={database.kind}
												// You can't alert on a metric nobody is collecting.
												disabledReason={
													neverCollected
														? "Branch metrics aren't being collected yet."
														: undefined
												}
											/>
										) : undefined
									}
									meta={
										database ? (
											<>
												<HeroChip>
													{database.kind === "postgresql"
														? "Postgres"
														: "MySQL / Vitess"}
												</HeroChip>
												{database.region ? (
													<HeroChip>{database.region}</HeroChip>
												) : null}
												{database.plan ? <HeroChip>{database.plan}</HeroChip> : null}
												<HeroChip>
													{database.branches.length} branch
													{database.branches.length === 1 ? "" : "es"}
												</HeroChip>
												{/* Identity chips first, then the removable filter rail
												    — same 10px mono vocabulary, different job. */}
												<PlanetScaleFilterChips
													filters={filters}
													onRemove={(chip) =>
														setFilter(
															chip.key,
															chip.key === "branchContains"
																? undefined
																: toggleFilterValue(
																		filters[chip.key],
																		chip.value,
																	),
														)
													}
													onClear={clearFilters}
												/>
											</>
										) : undefined
									}
								/>
								{status !== null && !status.connected ? (
									<PlanetScaleNotConnected />
								) : (
									<>
										{status?.revoked_at != null ? <PlanetScaleRevokedNotice /> : null}
										{/* Setup replaces the notice while nothing has ever been
										    collected — one screen saying one thing. */}
										{status?.metrics_auth === "missing" && !neverCollected ? (
											<PlanetScaleMetricsNotice />
										) : null}
										{neverCollected ? <PlanetScaleSetupState steps={setupSteps} /> : null}
										{resolution.kind === "unknown" ? (
											<UnknownBranchNotice
												name={resolution.name}
												fallback={resolution.fallback}
												onReset={() => selectBranch(undefined)}
											/>
										) : null}
										{/* Keyed on the database: TanStack Router swaps the param without
							    remounting, and the retained-value hooks would otherwise render
							    the previous database's numbers under this one's title. */}
										<PlanetScaleDatabaseData
											key={dbName}
											database={dbName}
											branch={selectedBranch?.name}
											startTime={startTime}
											endTime={endTime}
											metricsPaused={status?.metrics_auth === "missing"}
											neverCollected={neverCollected}
											candidates={filteredCandidates}
											selectedBranches={filters.branches ?? EMPTY_SELECTION}
											onToggleBranch={toggleBranch}
											branchStatsResult={branchStatsResult}
											selectedBranchName={selectedBranch?.name ?? null}
											onSelectBranch={selectBranch}
										/>
									</>
								)}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/** Scope selector. Always present once branches are known, so the page never hides its own scope. */
function BranchScopeSelect({
	candidates,
	selected,
	onSelect,
}: {
	candidates: ReadonlyArray<BranchCandidate>
	selected: BranchCandidate | null
	onSelect: (branch: string | undefined) => void
}) {
	if (candidates.length === 0) return null
	return (
		<Select
			items={Object.fromEntries(candidates.map((c) => [c.name, c.name]))}
			value={selected?.name ?? null}
			onValueChange={(value: string | null) => onSelect(value ?? undefined)}
		>
			<SelectTrigger size="sm" className="w-44 font-mono text-xs" aria-label="Branch">
				<SelectValue placeholder="Branch" />
			</SelectTrigger>
			<SelectContent>
				{candidates.map((c) => (
					<SelectItem key={c.name} value={c.name}>
						{c.name}
						{c.production ? " · production" : ""}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function UnknownBranchNotice({
	name,
	fallback,
	onReset,
}: {
	name: string
	fallback: BranchCandidate | null
	onReset: () => void
}) {
	return (
		<Empty className="py-10">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<PlanetScaleIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>
					No branch named <span className="font-mono">{name}</span>
				</EmptyTitle>
				<EmptyDescription>
					It may have been deleted, or the inventory hasn't refreshed since it was created.
				</EmptyDescription>
			</EmptyHeader>
			{fallback ? (
				<EmptyContent>
					<Button size="sm" variant="outline" onClick={onReset}>
						Show {fallback.name}
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	)
}

// Storage leads and spans the grid: it is the slow-moving number nothing else on
// the page reveals, and a wide plot is what makes a creeping disk legible.
const LEAD_METRIC: PlanetScaleMetric = "storageUsedPercent"
const GRID_METRICS: ReadonlyArray<PlanetScaleMetric> = [
	"connectionsAvg",
	"cpuMaxPercent",
	"memMaxPercent",
	"replicaLagMaxSeconds",
]

function PlanetScaleDatabaseData({
	database,
	branch,
	startTime,
	endTime,
	metricsPaused,
	neverCollected,
	candidates,
	selectedBranches,
	onToggleBranch,
	branchStatsResult,
	selectedBranchName,
	onSelectBranch,
}: {
	database: string
	branch: string | undefined
	startTime: string
	endTime: string
	metricsPaused: boolean
	/** No scrape has ever landed — the chart grid is skipped entirely. */
	neverCollected: boolean
	candidates: ReadonlyArray<BranchCandidate>
	/** Branch names the page is filtered to. Empty means all. */
	selectedBranches: ReadonlyArray<string>
	onToggleBranch: (branch: string) => void
	branchStatsResult: Result.Result<{ branches: ReadonlyArray<PlanetScaleBranchStat> }, unknown>
	selectedBranchName: string | null
	onSelectBranch: (branch: string | undefined) => void
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const timeseriesResult = useRetainedRefreshableResultValue(
		planetscaleInfraTimeseriesResultAtom({
			data: {
				database,
				startTime,
				endTime,
				bucketSeconds,
				...(!(branch === undefined) ? { branch } : undefined),
			},
		}),
	)

	const buckets = Result.builder(timeseriesResult)
		.onSuccess((r) => r.buckets)
		.orElse(() => NO_BUCKETS)
	const waiting = Boolean(timeseriesResult.waiting)

	// The lifecycle timeline: one fetch feeds both the chart markers and the feed
	// below, so the two can never disagree about what happened.
	const eventsResult = useRetainedRefreshableResultValue(
		planetscaleEventsResultAtom({
			data: {
				database,
				startTime: Date.parse(startTime),
				endTime: Date.parse(endTime),
				...(!(branch === undefined) ? { branch } : undefined),
			},
		}),
	)
	const events = Result.builder(eventsResult)
		.onSuccess((r) => r.events)
		.orElse(() => NO_EVENTS)
	const markers = useMemo(() => eventsToChartMarkers(events), [events])

	const selectedCandidate = candidates.find((c) => c.name === selectedBranchName) ?? null
	const reason = selectedCandidate === null ? null : absenceReason(selectedCandidate)
	const chartEmptyMessage = metricsPaused
		? METRICS_PAUSED_MESSAGE
		: reason !== null
			? BRANCH_ABSENCE_COPY[reason]
			: undefined

	// The scope marker is what stops the chart and the table from silently
	// disagreeing. With two or more branches selected the timeseries endpoint has
	// no faithful answer, so the chip says which one it fell back to.
	const scope = <PlanetScaleBranchScope selected={selectedBranches} surface="chart" />

	const charts = Result.isInitial(timeseriesResult) ? (
		<div className="space-y-4">
			<PlanetScaleChartLoading metric={LEAD_METRIC} />
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{GRID_METRICS.map((metric) => (
					<PlanetScaleChartLoading key={metric} metric={metric} />
				))}
			</div>
		</div>
	) : Result.isFailure(timeseriesResult) ? (
		// Section-scoped: a failed chart query must not take the branch table and
		// query insights down with it — they are separate queries.
		<QueryErrorState error={timeseriesResult.cause} />
	) : (
		<div className="space-y-4">
			<PlanetScaleChart
				buckets={buckets}
				metric={LEAD_METRIC}
				waiting={waiting}
				scope={scope}
				markers={markers}
				emptyMessage={chartEmptyMessage}
			/>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{GRID_METRICS.map((metric) => (
					<PlanetScaleChart
						key={metric}
						buckets={buckets}
						metric={metric}
						waiting={waiting}
						scope={scope}
						markers={markers}
						emptyMessage={chartEmptyMessage}
					/>
				))}
			</div>
		</div>
	)

	return (
		<div className="space-y-6">
			{/* Five empty plots is not information. The setup card above already
			    says why there is nothing to draw. */}
			{neverCollected ? null : <section className="space-y-3">{charts}</section>}

			{/* Between the charts and the tables: the markers above are the index,
			    this is the detail. */}
			<section className="space-y-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-sm font-medium text-foreground">Activity</h2>
					<span className="font-mono text-[11px] text-muted-foreground">{events.length}</span>
				</div>
				{Result.isInitial(eventsResult) ? (
					<PlanetScaleActivityFeedLoading />
				) : Result.isFailure(eventsResult) ? (
					// Section-scoped: a failed timeline must not take the charts down.
					<p className="py-2 text-xs text-muted-foreground">
						Couldn&apos;t load the deploy timeline for this window.
					</p>
				) : (
					<PlanetScaleActivityFeed
						events={events}
						waiting={Boolean(eventsResult.waiting)}
						onSelectBranch={onSelectBranch}
					/>
				)}
			</section>

			{/* One ranked branch table, not two: this panel absorbed the old
			    branch table's columns and its click-to-scope affordance. */}
			<section className="space-y-2">
				{Result.isInitial(branchStatsResult) ? (
					<PlanetScaleBranchBreakdownPanelLoading />
				) : Result.isFailure(branchStatsResult) ? (
					<QueryErrorState error={branchStatsResult.cause} />
				) : (
					<PlanetScaleBranchBreakdownPanel
						candidates={candidates}
						selectedBranches={selectedBranches}
						onToggleBranch={onToggleBranch}
						waiting={Boolean(branchStatsResult.waiting)}
						emptyMessage={
							metricsPaused ? METRICS_PAUSED_MESSAGE : "No branches match these filters."
						}
					/>
				)}
			</section>

			<section className="space-y-2">
				<div className="flex flex-wrap items-baseline justify-between gap-3">
					<div className="flex flex-wrap items-baseline gap-2">
						<h2 className="text-sm font-medium text-foreground">Top queries</h2>
						{/* Query Insights answers one branch at a time — with several
						    selected this says which one is on screen. */}
						<PlanetScaleBranchScope
							selected={selectedBranches}
							resolved={selectedBranchName}
							surface="insights"
						/>
					</div>
					<span className="text-[11px] text-muted-foreground">PlanetScale Query Insights</span>
				</div>
				<PlanetScaleTopQueries
					database={database}
					branch={branch}
					startTime={startTime}
					endTime={endTime}
					limit={12}
				/>
			</section>
		</div>
	)
}
