import { Link, useNavigate, createFileRoute } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Option, Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import {
	getServiceDetailOverviewResultAtom,
	getServiceDetailThroughputRefinementResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { mergeExactThroughput } from "@/api/warehouse/custom-charts"
import type { ServiceDetailOverviewResult } from "@/api/warehouse/custom-charts"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"
import { useCommitMarkers } from "@/components/vcs/commit-markers/use-commit-markers"
import type { ReleasePoint } from "@/components/vcs/commit-markers/marker-layout"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"
import { ServiceDependenciesTab } from "@/components/services/service-dependencies-tab"
import { ServiceEndpointsTab } from "@/components/services/service-endpoints-tab"
import { ServiceOperationsTab } from "@/components/services/service-operations-tab"
import { ServiceDependencyStrip } from "@/components/services/service-dependency-strip"
import { ServiceEnvironmentSwitcher } from "@/components/services/service-environment-switcher"
import { ServiceErrorsPanel } from "@/components/services/service-errors-panel"
import { ServiceRecentDeploys } from "@/components/services/service-recent-deploys"
import {
	ServiceTopEndpointsPanel,
	ServiceTopOperationsPanel,
} from "@/components/services/service-top-operations-panel"
import { ServiceUsagePanel } from "@/components/services/service-usage-panel"
import { ServiceWorkloadsPanel } from "@/components/services/service-workloads-panel"
import { OptionalStringArrayParam } from "@/lib/search-params"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"

// A stable empty releases array for the non-success render branches. Minting a
// fresh `[]` in the `.orElse` below would give `useCommitMarkers`' `useMemo` a new
// dependency identity every render, busting the marker cache.
const EMPTY_RELEASES: ReadonlyArray<ReleasePoint> = []
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

const ServiceDetailTab = Schema.Literals(["overview", "endpoints", "operations", "dependencies"])
type ServiceDetailTabValue = Schema.Schema.Type<typeof ServiceDetailTab>
const decodeServiceDetailTab = Schema.decodeUnknownOption(ServiceDetailTab)

const serviceDetailSearchSchema = Schema.Struct({
	// Plain string, narrowed via decodeServiceDetailTab at the use site — an
	// unknown value (e.g. a stale `?tab=traces` link) falls back to Overview
	// instead of failing route search validation.
	tab: Schema.optional(Schema.String),
	// Scopes the Overview charts to a single deployment environment (carried from
	// the clicked service-list row, or chosen via the env switcher). Single-element
	// by convention; `undefined` = all environments. Uses the JSON-string-tolerant
	// param so a serialized array URL survives TanStack Router's parseSearch.
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/services/$serviceName")({
	component: ServiceDetailPage,
	validateSearch: Schema.toStandardSchemaV1(serviceDetailSearchSchema),
})

interface ServiceChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

const SERVICE_CHARTS: ServiceChartConfig[] = [
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

function ServiceDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<ServiceDetailContent />
		</PageRefreshProvider>
	)
}

function ServiceDetailContent() {
	const { serviceName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = useCallback(
		(
			range: {
				startTime?: string
				endTime?: string
				presetValue?: string
			},
			options?: { replace?: boolean },
		) => {
			navigate({
				replace: options?.replace,
				search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
			})
		},
		[navigate],
	)

	// Lifted out of OverviewTab: the header's environment switcher and the tab
	// list below both read it, so it must resolve on every tab — a deep link to
	// `?tab=operations` still needs to know whether to offer Endpoints. Subscribing
	// here rather than in two children also collapses the duplicate subscription.
	const overviewAtom = getServiceDetailOverviewResultAtom({
		data: {
			serviceName,
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
			environments: search.environments,
		},
	})
	const overviewResult = useRetainedRefreshableResultValue(overviewAtom)

	// Detection rides the overview bundle (see the `serviceDetailOverview`
	// handler), so the Endpoints trigger appears with the first paint of the page
	// rather than after a second round-trip.
	const isHttpApi = Result.builder(overviewResult)
		.onSuccess((r) => r.apiProfile.isHttpApi)
		.orElse(() => false)

	const rawTab: ServiceDetailTabValue = Option.getOrElse(
		decodeServiceDetailTab(search.tab),
		(): ServiceDetailTabValue => "overview",
	)
	// A stale `?tab=endpoints` on a service that isn't an API (or one whose
	// detection hasn't resolved yet) falls back rather than rendering a tab with
	// no trigger.
	const activeTab: ServiceDetailTabValue = rawTab === "endpoints" && !isHttpApi ? "overview" : rawTab
	const handleTabChange = useCallback(
		(value: unknown) => {
			const next = Option.getOrElse(
				decodeServiceDetailTab(value),
				(): ServiceDetailTabValue => "overview",
			)
			navigate({
				replace: true,
				search: (prev: Record<string, unknown>) => ({
					...prev,
					tab: next === "overview" ? undefined : next,
				}),
			})
		},
		[navigate],
	)

	const handleEnvironmentChange = useCallback(
		(environment: string | undefined) => {
			navigate({
				search: (prev: Record<string, unknown>) => ({
					...prev,
					environments: environment ? [environment] : undefined,
				}),
			})
		},
		[navigate],
	)

	const handleShowDependencies = useCallback(() => handleTabChange("dependencies"), [handleTabChange])
	const handleShowOperations = useCallback(() => handleTabChange("operations"), [handleTabChange])
	const handleShowEndpoints = useCallback(() => handleTabChange("endpoints"), [handleTabChange])

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Services", href: "/services" }, { label: serviceName }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<PageLayout.Title className="flex items-center gap-2.5" title={serviceName}>
									<ServiceDot serviceName={serviceName} className="size-3" />
									<span className="truncate">{serviceName}</span>
								</PageLayout.Title>
							}
						>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
								{/* View switch lives inline with other page controls so it reads as a
												    perspective toggle, not a navigation bar. Sized to match the time
												    picker buttons (h-7) and tucked left of them so the visual order is:
												    "what view → what window → what action". */}
								<Tabs
									value={activeTab}
									onValueChange={handleTabChange}
									className="w-full sm:w-auto"
								>
									<TabsList variant="default" className="h-7 w-full gap-0 p-0.5 sm:w-auto">
										<TabsTrigger
											value="overview"
											className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
										>
											Overview
										</TabsTrigger>
										{/* Only for services detected as HTTP APIs. Additive — the
										    generic Operations tab stays, since an API service still
										    has internal spans worth seeing. */}
										{isHttpApi && (
											<TabsTrigger
												value="endpoints"
												className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
											>
												Endpoints
											</TabsTrigger>
										)}
										<TabsTrigger
											value="operations"
											className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
										>
											Operations
										</TabsTrigger>
										<TabsTrigger
											value="dependencies"
											className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
										>
											Dependencies
										</TabsTrigger>
									</TabsList>
								</Tabs>
								{/* Env scope drives every tab — the Dependencies bundle takes the same
												    single-select value via its deploymentEnv field (see
												    toSingleDeploymentEnv). */}
								<ServiceEnvironmentSwitcher
									serviceName={serviceName}
									startTime={effectiveStartTime}
									endTime={effectiveEndTime}
									environments={search.environments}
									value={search.environments?.[0]}
									onChange={handleEnvironmentChange}
								/>
								<div className="flex items-center gap-2">
									<TimeRangeHeaderControls
										startTime={search.startTime}
										endTime={search.endTime}
										presetValue={
											search.timePreset ?? (search.startTime ? undefined : "12h")
										}
										presets={LONG_RANGE_PRESET_OPTIONS}
										maxRangeSeconds={ONE_YEAR_SECONDS}
										onTimeChange={handleTimeChange}
									/>
									<Button
										variant="outline"
										aria-label="Create Alert"
										render={<Link to="/alerts/create" search={{ serviceName }} />}
									>
										<BellIcon size={14} />
										<span className="hidden sm:inline">Create Alert</span>
									</Button>
								</div>
							</div>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{activeTab === "overview" && (
							<OverviewTab
								serviceName={serviceName}
								effectiveStartTime={effectiveStartTime}
								effectiveEndTime={effectiveEndTime}
								environments={search.environments}
								overviewAtom={overviewAtom}
								overviewResult={overviewResult}
								isHttpApi={isHttpApi}
								onShowDependencies={handleShowDependencies}
								onShowOperations={handleShowOperations}
								onShowEndpoints={handleShowEndpoints}
							/>
						)}
						{activeTab === "endpoints" && (
							<ServiceEndpointsTab
								serviceName={serviceName}
								effectiveStartTime={effectiveStartTime}
								effectiveEndTime={effectiveEndTime}
								environments={search.environments}
								startTime={search.startTime}
								endTime={search.endTime}
								timePreset={search.timePreset}
							/>
						)}
						{activeTab === "operations" && (
							<ServiceOperationsTab
								serviceName={serviceName}
								effectiveStartTime={effectiveStartTime}
								effectiveEndTime={effectiveEndTime}
								environments={search.environments}
								startTime={search.startTime}
								endTime={search.endTime}
								timePreset={search.timePreset}
							/>
						)}
						{activeTab === "dependencies" && (
							<ServiceDependenciesTab
								serviceName={serviceName}
								startTime={search.startTime}
								endTime={search.endTime}
								timePreset={search.timePreset}
								effectiveStartTime={effectiveStartTime}
								effectiveEndTime={effectiveEndTime}
								environments={search.environments}
							/>
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

interface OverviewTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/**
	 * The overview bundle, subscribed by the page shell rather than here: the
	 * header's environment switcher and the tab list need it on every tab, so the
	 * subscription lives one level up and the atom + its result are passed down.
	 * Still one fetch for the whole tab (the switcher shares this atom key).
	 */
	/** Raw search params, forwarded to the endpoint detail route. */
	startTime?: string
	endTime?: string
	timePreset?: string
	overviewAtom: ReturnType<typeof getServiceDetailOverviewResultAtom>
	overviewResult: Result.Result<ServiceDetailOverviewResult, QueryAtomFailure>
	isHttpApi: boolean
	onShowDependencies: () => void
	onShowOperations: () => void
	onShowEndpoints: () => void
}

function OverviewTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
	overviewAtom,
	overviewResult,
	isHttpApi,
	onShowDependencies,
	onShowOperations,
	onShowEndpoints,
}: OverviewTabProps) {
	const refreshOverview = useAtomRefresh(overviewAtom)

	// Sampling verdict from the already-loaded primary chart. Drives a separate,
	// non-blocking fetch of the exact pre-sampling throughput (SpanMetrics `calls`)
	// — only when sampling is active, so unsampled services never issue the slow
	// query. `samplingActive` is part of the atom key, so the overlay re-fetches
	// once the primary resolves and flips it true (no `useEffect`).
	const samplingActive = Result.builder(overviewResult)
		.onSuccess((r) => r.data.some((p) => p.hasSampling))
		.orElse(() => false)

	const throughputRefinement = useAtomValue(
		getServiceDetailThroughputRefinementResultAtom({
			data: {
				serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments,
				samplingActive,
			},
		}),
	)

	const exactThroughputByBucket = useMemo(() => {
		const map = new Map<string, number>()
		Result.builder(throughputRefinement)
			.onSuccess((r) => {
				for (const point of r.data) map.set(point.bucket, point.throughput)
			})
			.orElse(() => undefined)
		return map
	}, [throughputRefinement])

	const isWaiting = Result.isSuccess(overviewResult) && overviewResult.waiting

	// Cold load (no retained data yet) → drive each chart's loading skeleton so
	// the grid shows `ChartSkeleton` until the warehouse query resolves, rather
	// than rendering an empty chart with `[]` while the data is still in flight.
	// On a refresh the retained hook returns `Success(waiting: true)` (not
	// `Initial`), so this stays false and the stale-data dim (`opacity-60`) wins.
	const isDetailLoading = Result.isInitial(overviewResult)

	// The typed per-bucket series, shared by the chart grid and the health strip's
	// window aggregates so both always describe the same data.
	const basePoints: ReadonlyArray<ServiceDetailTimeSeriesPoint> = useMemo(
		() =>
			Result.builder(overviewResult)
				.onSuccess((response) => response.data)
				.orElse(() => []),
		[overviewResult],
	)

	// ServiceDetail points are typed structs; the chart grid consumes a
	// generic `Record<string, unknown>[]`. Each point's fields are all primitive,
	// so this is a safe widening (no `as unknown` round-trip needed). The exact
	// SpanMetrics throughput overlay (when present) is merged by ISO bucket here.
	const detailPoints: Record<string, unknown>[] = useMemo(() => {
		return mergeExactThroughput(basePoints, exactThroughputByBucket).map((point) => ({ ...point }))
	}, [basePoints, exactThroughputByBucket])

	// Commit deploy markers (dashed verticals + labels) drawn over every chart.
	// Derived from the overview's release timeline and snapped onto the chart's
	// own bucket grid so each marker sits on an x-tick.
	const releases = useMemo(
		() =>
			Result.builder(overviewResult)
				.onSuccess((response) => response.releases)
				.orElse(() => EMPTY_RELEASES),
		[overviewResult],
	)
	const chartBuckets = useMemo(() => detailPoints.map((point) => String(point.bucket)), [detailPoints])
	const commitMarkers = useCommitMarkers(releases, chartBuckets)

	// Stable identity so the memoized chart components under MetricsGrid skip
	// rerenders when this tab rerenders for unrelated reasons (sibling panel
	// atoms settling, root-level churn).
	const metrics = useMemo(
		() =>
			SERVICE_CHARTS.map((chart) => ({
				id: chart.id,
				chartId: chart.chartId,
				title: chart.title,
				layout: chart.layout,
				data: detailPoints,
				legend: chart.legend,
				tooltip: chart.tooltip,
				rateMode: chart.rateMode,
				isLoading: isDetailLoading,
			})),
		[detailPoints, isDetailLoading],
	)

	if (Result.isFailure(overviewResult)) {
		return (
			<QueryErrorState
				error={overviewResult.cause}
				titleOverride="Failed to load service overview"
				onRetry={refreshOverview}
			/>
		)
	}

	return (
		<div className="flex flex-col gap-3">
			<MetricsGrid
				items={metrics}
				waiting={!!isWaiting}
				syncMode="cursor"
				syncId={`service-${serviceName}`}
				overlay={commitMarkers}
				// Pin every chart's y-axis to one width so their plot areas align — the
				// synced cursor and the commit markers then line up and group identically
				// across charts (otherwise each chart's own y-axis width shifts the plot,
				// and the same commits group differently per chart). 72 fits the widest
				// of these metrics' tick labels (latency ms).
				yAxisWidth={72}
			/>
			{/* An API service leads with its endpoints; everything else leads with
			    raw operations. Both read the same atom key their tab uses, so the
			    tab that follows is a cache hit. */}
			{isHttpApi ? (
				<ServiceTopEndpointsPanel
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					environments={environments}
					startTime={startTime}
					endTime={endTime}
					timePreset={timePreset}
					onViewAll={onShowEndpoints}
				/>
			) : (
				<ServiceTopOperationsPanel
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					environments={environments}
					onViewAll={onShowOperations}
				/>
			)}
			<div className="grid gap-3 lg:grid-cols-2">
				<ServiceErrorsPanel
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					environments={environments}
				/>
				<ServiceRecentDeploys releases={releases} isLoading={isDetailLoading} />
				{/* Usage + workloads are env-agnostic by design (rollup keyed
				    org/hour/service; workload identity carries no env) — they flag
				    themselves "all environments" when the page filter is active. */}
				<ServiceUsagePanel
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					envFilterActive={!!environments?.length}
				/>
				<ServiceWorkloadsPanel
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					envFilterActive={!!environments?.length}
				/>
			</div>
			<ServiceDependencyStrip
				serviceName={serviceName}
				effectiveStartTime={effectiveStartTime}
				effectiveEndTime={effectiveEndTime}
				environments={environments}
				onViewAll={onShowDependencies}
			/>
		</div>
	)
}
