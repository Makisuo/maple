import { useMemo } from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Result, useAtomValue, useAtomSet, useAtomRefresh } from "@/lib/effect-atom"
import { Schema } from "effect"
import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	dashboardFacetsHintAtomFamily,
	type DashboardFacetsHint,
} from "@/atoms/dashboard-facets-hint-atoms"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorState } from "@/components/common/error-state"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { formatErrorRate } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { ServiceUsageCards } from "@/components/dashboard/service-usage-cards"
import { ServiceHealthOverview, ServiceHealthList } from "@/components/dashboard/service-health-section"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import { SetupChecklist } from "@/components/dashboard/setup-checklist"
import { FirstActionHint } from "@/components/dashboard/first-action-hint"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import {
	getCustomChartTimeSeriesResultAtom,
	getOverviewThroughputRefinementResultAtom,
	getOverviewTimeSeriesResultAtom,
	getServicesFacetsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { mergeExactThroughput, type CustomChartTimeSeriesResponse } from "@/api/warehouse/custom-charts"
import type { ServiceDetailTimeSeriesPoint, ServicesFacetsResponse } from "@/api/warehouse/services"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const dashboardSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/"))({
	component: DashboardPage,
	validateSearch: Schema.toStandardSchemaV1(dashboardSearchSchema),
})

interface OverviewChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

const EMPTY_ARRAY: Record<string, unknown>[] = []

const OVERVIEW_CHARTS: OverviewChartConfig[] = [
	{
		id: "throughput",
		chartId: "throughput-area",
		title: "Request Volume",
		layout: { x: 0, y: 0, w: 6, h: 4 },
		tooltip: "visible",
		rateMode: "per_second",
	},
	{
		id: "error-rate",
		chartId: "error-rate-area",
		title: "Error Rate",
		layout: { x: 6, y: 0, w: 6, h: 4 },
		tooltip: "visible",
	},
	{
		id: "latency",
		chartId: "latency-line",
		title: "Latency",
		layout: { x: 0, y: 4, w: 6, h: 4 },
		legend: "visible",
		tooltip: "visible",
	},
	{
		id: "log-volume",
		chartId: "throughput-area",
		title: "Log Volume",
		layout: { x: 6, y: 4, w: 6, h: 4 },
		tooltip: "visible",
	},
]

function DashboardPage() {
	const search = Route.useSearch()
	// `orgId` is guaranteed on this route (root `beforeLoad` redirects to
	// /org-required otherwise) and comes from the router context, so it's
	// available in both Clerk and non-Clerk auth modes. Scopes the per-org hint.
	const { auth } = Route.useRouteContext()
	const orgKey = auth.orgId ?? "default"
	const hint = useAtomValue(dashboardFacetsHintAtomFamily(orgKey))

	// Stable 24h range, computed once per mount. Drives the single facets call
	// shared by `useDefaultPreset` and `DashboardContent` so we issue one HTTP
	// request instead of two. Environments / commit SHAs / service names move
	// slowly enough that a fixed 24h window is fine for the dropdown — and it
	// matches the old probe's range, so demo-detection behavior is unchanged.
	// `TinybirdDateTime` requires `YYYY-MM-DD HH:mm:ss` (no `T`, no millis), so
	// we strip the ISO suffix instead of passing `.toISOString()` raw.
	const facetsRange = useMemo(() => {
		const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
		const end = new Date()
		const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
		return { startTime: fmt(start), endTime: fmt(end) }
	}, [])

	const facetsAtom = getServicesFacetsResultAtom({ data: facetsRange })
	const facetsResult = useRetainedRefreshableResultValue(facetsAtom)
	const refreshFacets = useAtomRefresh(facetsAtom)

	const defaultPreset = useMemo(() => {
		// Before facets resolve, fall back to the persisted hint's preset so the
		// time picker + downstream queries use the org's likely default (6h for
		// all-demo orgs, else 24h) instead of always guessing 24h.
		if (!Result.isSuccess(facetsResult)) return hint.preset
		const services = facetsResult.value.data.services
		if (services.length === 0) return "24h"
		const allDemo = services.every((s) => s.name.startsWith("demo-"))
		return allDemo ? "6h" : "24h"
	}, [facetsResult, hint.preset])

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? defaultPreset}>
			<DashboardContent
				defaultPreset={defaultPreset}
				facetsResult={facetsResult}
				onRetryFacets={refreshFacets}
				orgKey={orgKey}
				hint={hint}
			/>
		</PageRefreshProvider>
	)
}

function DashboardContent({
	defaultPreset,
	facetsResult,
	onRetryFacets,
	orgKey,
	hint,
}: {
	defaultPreset: string
	facetsResult: Result.Result<ServicesFacetsResponse, unknown>
	onRetryFacets: () => void
	orgKey: string
	hint: DashboardFacetsHint
}) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? defaultPreset,
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

	const handleEnvironmentChange = (value: string | null) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({
				...prev,
				environment: value === "__all__" ? undefined : (value ?? undefined),
			}),
		})
	}

	const environments = Result.builder(facetsResult)
		.onSuccess((response) => response.data.environments)
		.orElse(() => [])

	const facetsReady = !Result.isInitial(facetsResult)

	// The facets-derived default environment ("production" when present, else
	// `null` = all). This is what we persist as the hint and use as the optimistic
	// filter before facets resolve — independent of any explicit `?environment=`.
	const derivedDefaultEnvironment = facetsReady
		? environments.some((e) => e.name === "production")
			? "production"
			: null
		: null

	// Derive effective environment filter (no URL writes). Explicit choice wins;
	// once facets resolve, use the production default; before that, fall back to
	// the persisted hint so the downstream queries can fetch optimistically.
	const environmentFilter = (() => {
		if (search.environment) return [search.environment]
		if (facetsReady) return derivedDefaultEnvironment ? [derivedDefaultEnvironment] : undefined
		return hint.environment ? [hint.environment] : undefined
	})()

	const selectedEnvironment =
		search.environment ?? (environments.some((e) => e.name === "production") ? "production" : "__all__")

	// We can fetch downstream as soon as we have a basis for the params: either
	// facets have resolved, or a prior load left a hint (`seen`). Preserving the
	// gate only when there's no hint keeps the very first load's behavior
	// identical (no new undefined → ["production"] double-fetch); every load after
	// the first fires downstream in parallel with facets instead of waiting.
	//
	// On the eventual facets resolution the params may change (hint → real); the
	// atom family re-keys (it's keyed by encoded params) and refetches, and
	// `useRetainedRefreshableResultValue` keeps the prior value on screen
	// (`waiting`) so there's no flash to a spinner.
	const canFetch = facetsReady || hint.seen

	const overviewAtom = canFetch
		? getOverviewTimeSeriesResultAtom({
				data: {
					startTime: effectiveStartTime,
					endTime: effectiveEndTime,
					environments: environmentFilter,
				},
			})
		: // eslint-disable-next-line @typescript-eslint/no-explicit-any
			disabledResultAtom<{ data: ServiceDetailTimeSeriesPoint[] }, any>()
	const overviewResult = useRetainedRefreshableResultValue(overviewAtom)
	const refreshOverview = useAtomRefresh(overviewAtom)

	const logVolumeAtom = canFetch
		? getCustomChartTimeSeriesResultAtom({
				data: {
					source: "logs",
					metric: "count",
					groupBy: "none",
					startTime: effectiveStartTime,
					endTime: effectiveEndTime,
					filters: {
						serviceName: undefined,
						environments: environmentFilter,
					},
				},
			})
		: // eslint-disable-next-line @typescript-eslint/no-explicit-any
			disabledResultAtom<CustomChartTimeSeriesResponse, any>()
	const logVolumeResult = useRetainedRefreshableResultValue(logVolumeAtom)
	const refreshLogVolume = useAtomRefresh(logVolumeAtom)

	const isWaiting =
		(Result.isSuccess(overviewResult) && overviewResult.waiting) ||
		(Result.isSuccess(logVolumeResult) && logVolumeResult.waiting)

	// Sampling verdict from the loaded overview chart; drives a non-blocking fetch
	// of the exact pre-sampling request volume (SpanMetrics `calls`) only when
	// sampling is active. Env-scoped views skip it (handled in the effect).
	const overviewSamplingActive =
		canFetch &&
		Result.builder(overviewResult)
			.onSuccess((r) => r.data.some((p) => p.hasSampling))
			.orElse(() => false)

	const throughputRefinementAtom = getOverviewThroughputRefinementResultAtom({
		data: {
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
			environments: environmentFilter,
			samplingActive: overviewSamplingActive,
		},
	})
	const throughputRefinement = useAtomValue(throughputRefinementAtom)
	const refreshThroughputRefinement = useAtomRefresh(throughputRefinementAtom)

	const exactThroughputByBucket = useMemo(() => {
		const map = new Map<string, number>()
		Result.builder(throughputRefinement)
			.onSuccess((r) => {
				for (const point of r.data) map.set(point.bucket, point.throughput)
			})
			.orElse(() => undefined)
		return map
	}, [throughputRefinement])

	// Overview points are typed structs; the chart grid consumes a generic
	// `Record<string, unknown>[]`. Each point's fields are all primitive, so
	// spreading widens to the record shape without an `as unknown` round-trip. The
	// exact SpanMetrics throughput overlay (when present) is merged by ISO bucket.
	const overviewPoints: Record<string, unknown>[] = useMemo(() => {
		const base: ReadonlyArray<ServiceDetailTimeSeriesPoint> = Result.builder(overviewResult)
			.onSuccess((response) => response.data)
			.orElse(() => [])
		if (base.length === 0) return EMPTY_ARRAY
		return mergeExactThroughput(base, exactThroughputByBucket).map((point) => ({ ...point }))
	}, [overviewResult, exactThroughputByBucket])

	const logPoints = Result.builder(logVolumeResult)
		.onSuccess(
			(response) =>
				response.data.map((point) => {
					const total = Object.values(point.series).reduce<number>(
						(sum, val) => sum + (typeof val === "number" ? val : 0),
						0,
					)
					return { bucket: point.bucket, throughput: total }
				}) as unknown as Record<string, unknown>[],
		)
		.orElse(() => EMPTY_ARRAY)

	const isOverviewLoading = Result.isInitial(overviewResult)
	const isLogVolumeLoading = Result.isInitial(logVolumeResult)

	const metrics = useMemo(() => {
		const overviewError = Result.builder(overviewResult)
			.onError((error) => ({ error, onRetry: refreshOverview }))
			.orElse(() => undefined)
		const logVolumeError = Result.builder(logVolumeResult)
			.onError((error) => ({ error, onRetry: refreshLogVolume }))
			.orElse(() => undefined)
		// The exact pre-sampling throughput overlay is a refinement of the base
		// chart, so its failure surfaces as a footer note instead of replacing
		// the (still valid) sampled series.
		const refinementErrorFooter = Result.builder(throughputRefinement)
			.onError((error) => (
				<ErrorState
					variant="inline"
					error={error}
					title="Exact request volume unavailable"
					onRetry={refreshThroughputRefinement}
					className="py-0"
				/>
			))
			.orElse(() => undefined)

		const errorMap: Record<string, { error: unknown; onRetry?: () => void } | undefined> = {
			throughput: overviewError,
			"error-rate": overviewError,
			latency: overviewError,
			"log-volume": logVolumeError,
		}

		const loadingMap: Record<string, boolean> = {
			throughput: isOverviewLoading,
			"error-rate": isOverviewLoading,
			latency: isOverviewLoading,
			"log-volume": isLogVolumeLoading,
		}

		const dataMap: Record<string, Record<string, unknown>[]> = {
			throughput: overviewPoints,
			"error-rate": overviewPoints,
			latency: overviewPoints,
			"log-volume": logPoints,
		}

		const totalVolume = overviewPoints.reduce(
			(sum, point) => sum + (typeof point.throughput === "number" ? point.throughput : 0),
			0,
		)
		// `errorRate` is a fraction (errors / requests); volume-weight it across buckets.
		const weightedErrors = overviewPoints.reduce((sum, point) => {
			const requests = typeof point.throughput === "number" ? point.throughput : 0
			const rate = typeof point.errorRate === "number" ? point.errorRate : 0
			return sum + requests * rate
		}, 0)
		const avgErrorRate = totalVolume > 0 ? weightedErrors / totalVolume : 0

		return OVERVIEW_CHARTS.map((chart) => ({
			id: chart.id,
			chartId: chart.chartId,
			title: chart.title,
			layout: chart.layout,
			data: dataMap[chart.id] ?? EMPTY_ARRAY,
			legend: chart.legend,
			tooltip: chart.tooltip,
			rateMode: chart.rateMode,
			isLoading: loadingMap[chart.id] ?? false,
			error: errorMap[chart.id],
			headerValue:
				chart.id === "error-rate" && !isOverviewLoading && !errorMap[chart.id] ? (
					<span className="text-chart-error">{formatErrorRate(avgErrorRate)}</span>
				) : undefined,
			footer:
				chart.id === "throughput" && !isOverviewLoading && !errorMap[chart.id] ? (
					(refinementErrorFooter ?? (
						<>
							Total{" "}
							<span className="font-medium text-foreground tabular-nums">
								{totalVolume.toLocaleString()}
							</span>
						</>
					))
				) : undefined,
		}))
	}, [
		overviewPoints,
		logPoints,
		isOverviewLoading,
		isLogVolumeLoading,
		overviewResult,
		logVolumeResult,
		throughputRefinement,
		refreshOverview,
		refreshLogVolume,
		refreshThroughputRefinement,
	])

	const environmentItems = useMemo(
		() => [
			{ value: "__all__", label: "All Environments" },
			...environments.map((e) => ({ value: e.name, label: e.name })),
		],
		[environments],
	)

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Overview" }]}
			title="Dashboard"
			description="Observability overview for your services."
			headerActions={
				<div className="flex items-center gap-2">
					<Select
						items={environmentItems}
						value={selectedEnvironment}
						onValueChange={handleEnvironmentChange}
					>
						<SelectTrigger size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{environmentItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<TimeRangeHeaderControls
						startTime={search.startTime ?? effectiveStartTime}
						endTime={search.endTime ?? effectiveEndTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : defaultPreset)}
						defaultPreset={defaultPreset}
						onTimeChange={handleTimeChange}
					/>
				</div>
			}
		>
			{isClerkAuthEnabled && (
				<>
					<FirstActionHint />
					<SetupChecklist />
				</>
			)}
			{/* Facets drive the environment dropdown and the default preset; when
			    they fail the charts below still load (unfiltered), so surface the
			    failure instead of silently offering an empty environment list. */}
			{Result.builder(facetsResult)
				.onError((error) => (
					<ErrorState
						variant="inline"
						error={error}
						title="Failed to load environments"
						onRetry={onRetryFacets}
					/>
				))
				.render()}
			{/* Persist the facets-derived defaults once facets resolve, so the next
			    cold load can fetch optimistically. Gated on `facetsReady` and keyed
			    by the derived hint so it remounts (re-persists) only when the value
			    actually changes — no bare effect, no per-render writes. */}
			{facetsReady && (
				<FacetsHintPersister
					key={`${derivedDefaultEnvironment ?? "__all__"}:${defaultPreset}`}
					orgKey={orgKey}
					environment={derivedDefaultEnvironment}
					preset={defaultPreset}
				/>
			)}
			<ServiceHealthOverview
				startTime={effectiveStartTime}
				endTime={effectiveEndTime}
				timePreset={search.timePreset ?? defaultPreset}
				environments={environmentFilter}
				canFetch={canFetch}
			/>
			<ServiceUsageCards startTime={effectiveStartTime} endTime={effectiveEndTime} />
			<MetricsGrid items={metrics} className="mt-4" waiting={!!isWaiting} syncId="home-overview" />
			<ServiceHealthList
				startTime={effectiveStartTime}
				endTime={effectiveEndTime}
				timePreset={search.timePreset ?? defaultPreset}
				environments={environmentFilter}
				canFetch={canFetch}
			/>
		</DashboardLayout>
	)
}

/**
 * Writes the facets-derived defaults to the per-org hint atom on mount. Rendered
 * only when facets are ready and remounted via `key` when the derived values
 * change (see call site), so `useMountEffect` is the correct one-shot sync.
 */
function FacetsHintPersister({
	orgKey,
	environment,
	preset,
}: {
	orgKey: string
	environment: string | null
	preset: string
}) {
	const setHint = useAtomSet(dashboardFacetsHintAtomFamily(orgKey))
	useMountEffect(() => {
		setHint({ environment, preset, seen: true })
	})
	return null
}
