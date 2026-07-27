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
import { ScopeChip } from "@/components/infra/primitives/scope-chip"
import {
	PlanetScaleBranchTable,
	PlanetScaleBranchTableLoading,
} from "@/components/infra/planetscale/planetscale-branch-table"
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
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	getPlanetScaleBranchStatsResultAtom,
	planetscaleInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { PlanetScaleInfraTimeseriesRow } from "@/api/warehouse/planetscale-infra"
import type { PlanetScaleBranchStat } from "@/api/warehouse/service-map"

const planetscaleDbSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	/**
	 * Scopes the charts and query insights. Absent means the resolved production
	 * branch — deliberately not written into the URL on load, so a shared link
	 * always shows what the sender saw.
	 */
	branch: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/planetscale/$dbName")({
	component: PlanetScaleDatabasePage,
	validateSearch: Schema.toStandardSchemaV1(planetscaleDbSearchSchema),
})

/** Stable empty fallbacks — a fresh `[]` per render busts every downstream memo. */
const NO_BUCKETS: ReadonlyArray<PlanetScaleInfraTimeseriesRow> = []
const NO_BRANCH_STATS: ReadonlyArray<PlanetScaleBranchStat> = []

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

	const selectBranch = (branch: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, branch }) })
	}

	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleStatus", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const inventoryResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleDatabases", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const database = Result.builder(inventoryResult)
		.onSuccess((inventory) => inventory.databases.find((db) => db.name === dbName) ?? null)
		.orElse(() => null)

	const status = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)

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
					status?.scrapeTarget?.includeBranches ?? [],
					status?.scrapeTarget?.excludeBranches ?? [],
				),
			),
		[database, branchStats, status],
	)
	const resolution = useMemo(
		() => resolveSelectedBranch(candidates, search.branch),
		[candidates, search.branch],
	)
	const selectedBranch = resolution.kind === "resolved" ? resolution.branch : null

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "PlanetScale", href: "/infra/planetscale" },
					{ label: dbName },
				]}
				headerActions={
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
							presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
							onTimeChange={handleTimeChange}
						/>
					</div>
				}
			>
				<div className="space-y-6">
					<PageHero
						title={dbName}
						description="Branch-level health, live from PlanetScale."
						meta={
							database ? (
								<>
									<HeroChip>
										{database.kind === "postgresql" ? "Postgres" : "MySQL / Vitess"}
									</HeroChip>
									{database.region ? <HeroChip>{database.region}</HeroChip> : null}
									{database.plan ? <HeroChip>{database.plan}</HeroChip> : null}
									<HeroChip>
										{database.branches.length} branch
										{database.branches.length === 1 ? "" : "es"}
									</HeroChip>
								</>
							) : undefined
						}
					/>
					{status !== null && !status.connected ? (
						<PlanetScaleNotConnected />
					) : (
						<>
							{status?.revokedAt != null ? <PlanetScaleRevokedNotice /> : null}
							{status?.metricsAuth === "missing" ? <PlanetScaleMetricsNotice /> : null}
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
								metricsPaused={status?.metricsAuth === "missing"}
								candidates={candidates}
								branchStatsResult={branchStatsResult}
								selectedBranchName={selectedBranch?.name ?? null}
								onSelectBranch={selectBranch}
							/>
						</>
					)}
				</div>
			</DashboardLayout>
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
	candidates,
	branchStatsResult,
	selectedBranchName,
	onSelectBranch,
}: {
	database: string
	branch: string | undefined
	startTime: string
	endTime: string
	metricsPaused: boolean
	candidates: ReadonlyArray<BranchCandidate>
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
				...(branch === undefined ? {} : { branch }),
			},
		}),
	)

	const buckets = Result.builder(timeseriesResult)
		.onSuccess((r) => r.buckets)
		.orElse(() => NO_BUCKETS)
	const waiting = Boolean(timeseriesResult.waiting)

	const selectedCandidate = candidates.find((c) => c.name === selectedBranchName) ?? null
	const reason = selectedCandidate === null ? null : absenceReason(selectedCandidate)
	const chartEmptyMessage = metricsPaused
		? METRICS_PAUSED_MESSAGE
		: reason !== null
			? BRANCH_ABSENCE_COPY[reason]
			: undefined

	// The scope marker is what stops the chart and the table from silently
	// disagreeing: these gauges are per branch, and the page says which one.
	const scope =
		branch === undefined ? (
			<ScopeChip tone="muted" explanation="Every branch in this database, combined.">
				all branches
			</ScopeChip>
		) : (
			<ScopeChip>{branch}</ScopeChip>
		)

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
				syncId={`ps-${database}`}
				scope={scope}
				emptyMessage={chartEmptyMessage}
			/>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{GRID_METRICS.map((metric) => (
					<PlanetScaleChart
						key={metric}
						buckets={buckets}
						metric={metric}
						waiting={waiting}
						syncId={`ps-${database}`}
						scope={scope}
						emptyMessage={chartEmptyMessage}
					/>
				))}
			</div>
		</div>
	)

	return (
		<div className="space-y-6">
			<section className="space-y-3">{charts}</section>

			<section className="space-y-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-sm font-medium text-foreground">Branches</h2>
					<span className="font-mono text-[11px] text-muted-foreground">
						{candidates.length}
					</span>
				</div>
				{Result.isInitial(branchStatsResult) ? (
					<PlanetScaleBranchTableLoading />
				) : Result.isFailure(branchStatsResult) ? (
					<QueryErrorState error={branchStatsResult.cause} />
				) : (
					<PlanetScaleBranchTable
						candidates={candidates}
						selectedBranch={selectedBranchName}
						onSelectBranch={onSelectBranch}
						waiting={Boolean(branchStatsResult.waiting)}
						emptyMessage={
							metricsPaused ? METRICS_PAUSED_MESSAGE : "No branches in this database."
						}
					/>
				)}
			</section>

			<section className="space-y-2">
				<div className="flex items-baseline justify-between gap-3">
					<h2 className="text-sm font-medium text-foreground">Top queries</h2>
					<span className="text-[11px] text-muted-foreground">
						PlanetScale Query Insights
					</span>
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
