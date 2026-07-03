import { Link, useNavigate, createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type {
	ChartLegendMode,
	ChartTooltipMode,
} from "@maple/ui/components/charts/_shared/chart-types"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import {
	getServiceDetailOverviewResultAtom,
	getServiceDetailThroughputRefinementResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { mergeExactThroughput } from "@/api/warehouse/custom-charts"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"
import { useCommitMarkers } from "@/components/vcs/commit-markers/use-commit-markers"
import type { ReleasePoint } from "@/components/vcs/commit-markers/marker-layout"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"
import { ServiceDependenciesTab } from "@/components/services/service-dependencies-tab"
import { ServiceEnvironmentSwitcher } from "@/components/services/service-environment-switcher"
import { OptionalStringArrayParam } from "@/lib/search-params"

// A stable empty releases array for the non-success render branches. Minting a
// fresh `[]` in the `.orElse` below would give `useCommitMarkers`' `useMemo` a new
// dependency identity every render, busting the marker cache.
const EMPTY_RELEASES: ReadonlyArray<ReleasePoint> = []

const ServiceDetailTab = Schema.Literals(["overview", "dependencies"])
type ServiceDetailTabValue = Schema.Schema.Type<typeof ServiceDetailTab>

const serviceDetailSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	tab: Schema.optional(ServiceDetailTab),
	// Scopes the Overview charts to a single deployment environment (carried from
	// the clicked service-list row, or chosen via the env switcher). Single-element
	// by convention; `undefined` = all environments. Uses the JSON-string-tolerant
	// param so a serialized array URL survives TanStack Router's parseSearch.
	environments: OptionalStringArrayParam,
})

export const Route = effectRoute(createFileRoute("/services/$serviceName"))({
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

	const handleTimeChange = (
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
	}

	const activeTab: ServiceDetailTabValue = search.tab ?? "overview"
	const handleTabChange = (value: unknown) => {
		const next = value === "dependencies" ? "dependencies" : "overview"
		navigate({
			replace: true,
			search: (prev: Record<string, unknown>) => ({
				...prev,
				tab: next === "overview" ? undefined : next,
			}),
		})
	}

	const handleEnvironmentChange = (environment: string | undefined) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({
				...prev,
				environments: environment ? [environment] : undefined,
			}),
		})
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Services", href: "/services" }, { label: serviceName }]}
			title={serviceName}
			headerActions={
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					{/* View switch lives inline with other page controls so it reads as a
					    perspective toggle, not a navigation bar. Sized to match the time
					    picker buttons (h-7) and tucked left of them so the visual order is:
					    "what view → what window → what action". */}
					<Tabs value={activeTab} onValueChange={handleTabChange} className="w-full sm:w-auto">
						<TabsList variant="default" className="h-7 w-full gap-0 p-0.5 sm:w-auto">
							<TabsTrigger
								value="overview"
								className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
							>
								Overview
							</TabsTrigger>
							<TabsTrigger
								value="dependencies"
								className="h-6 flex-1 px-2.5 text-xs font-medium sm:h-6 sm:flex-initial sm:text-xs"
							>
								Dependencies
							</TabsTrigger>
						</TabsList>
					</Tabs>
					{/* Env scope only applies to the Overview charts; hide it on the
					    Dependencies tab so it can't imply a filter it doesn't drive. */}
					{activeTab === "overview" && (
						<ServiceEnvironmentSwitcher
							serviceName={serviceName}
							startTime={effectiveStartTime}
							endTime={effectiveEndTime}
							environments={search.environments}
							value={search.environments?.[0]}
							onChange={handleEnvironmentChange}
						/>
					)}
					<div className="flex items-center gap-2">
						<TimeRangeHeaderControls
							startTime={search.startTime}
							endTime={search.endTime}
							presetValue={search.timePreset ?? "12h"}
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
			}
		>
			{activeTab === "overview" ? (
				<OverviewTab
					serviceName={serviceName}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
					environments={search.environments}
				/>
			) : (
				<ServiceDependenciesTab
					serviceName={serviceName}
					startTime={search.startTime}
					endTime={search.endTime}
					timePreset={search.timePreset}
					effectiveStartTime={effectiveStartTime}
					effectiveEndTime={effectiveEndTime}
				/>
			)}
		</DashboardLayout>
	)
}

interface OverviewTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
}

function OverviewTab({ serviceName, effectiveStartTime, effectiveEndTime, environments }: OverviewTabProps) {
	// One fetch for the whole Overview tab — the primary chart and the environment
	// switcher's options (the switcher reads this same atom key, so it shares this
	// round-trip instead of issuing its own overview query).
	const overviewResult = useRetainedRefreshableResultValue(
		getServiceDetailOverviewResultAtom({
			data: {
				serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments,
			},
		}),
	)

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

	// ServiceDetail points are typed structs; the chart grid consumes a
	// generic `Record<string, unknown>[]`. Each point's fields are all primitive,
	// so this is a safe widening (no `as unknown` round-trip needed). The exact
	// SpanMetrics throughput overlay (when present) is merged by ISO bucket here.
	const detailPoints: Record<string, unknown>[] = useMemo(() => {
		const base: ReadonlyArray<ServiceDetailTimeSeriesPoint> = Result.builder(overviewResult)
			.onSuccess((response) => response.data)
			.orElse(() => [])
		return mergeExactThroughput(base, exactThroughputByBucket).map((point) => ({ ...point }))
	}, [overviewResult, exactThroughputByBucket])

	// Commit deploy markers (dashed verticals + labels) drawn over every chart.
	// Derived from the overview's release timeline and snapped onto the chart's
	// own bucket grid so each marker sits on an x-tick.
	const releases = Result.builder(overviewResult)
		.onSuccess((response) => response.releases)
		.orElse(() => EMPTY_RELEASES)
	const chartBuckets = useMemo(() => detailPoints.map((point) => String(point.bucket)), [detailPoints])
	const commitMarkers = useCommitMarkers(releases, chartBuckets)

	const widgetData: Record<string, Record<string, unknown>[]> = {
		latency: detailPoints,
		throughput: detailPoints,
		"error-rate": detailPoints,
		apdex: detailPoints,
	}

	const metrics = SERVICE_CHARTS.map((chart) => ({
		id: chart.id,
		chartId: chart.chartId,
		title: chart.title,
		layout: chart.layout,
		data: widgetData[chart.id] ?? [],
		legend: chart.legend,
		tooltip: chart.tooltip,
		rateMode: chart.rateMode,
		isLoading: isDetailLoading,
	}))

	return (
		<MetricsGrid
			items={metrics}
			waiting={!!isWaiting}
			syncId={`service-${serviceName}`}
			overlay={commitMarkers}
			// Pin every chart's y-axis to one width so their plot areas align — the
			// synced cursor and the commit markers then line up and group identically
			// across charts (otherwise each chart's own y-axis width shifts the plot,
			// and the same commits group differently per chart). 72 fits the widest
			// of these metrics' tick labels (latency ms).
			yAxisWidth={72}
		/>
	)
}
