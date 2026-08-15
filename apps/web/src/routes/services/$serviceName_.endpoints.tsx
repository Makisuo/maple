import { Link, useNavigate, createFileRoute } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import {
	getEndpointDetailChartsResultAtom,
	getEndpointStatusBreakdownResultAtom,
	listTracesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"
import { ServiceEnvironmentSwitcher } from "@/components/services/service-environment-switcher"
import { SectionCard } from "@/components/services/section-card"
import { MethodBadge, RouteLabel } from "@/components/services/service-endpoints-tab"
import { endpointSpanName } from "@/components/services/service-endpoints"
import { operationTraceSearch } from "@/components/services/service-operations"
import { OptionalStringArrayParam } from "@/lib/search-params"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const SLOW_TRACES_LIMIT = 8
// `trace_list_mv` retains 30 days; the summary charts read raw traces and cover
// the full range, so a longer window still renders — only this list is clamped.
const TRACE_DETAIL_WINDOW_SECONDS = 30 * 24 * 60 * 60

/**
 * The endpoint's identity lives in search params, not the path. A route contains
 * slashes, and folding one into a single path segment means `%2F` round-tripping
 * (and an unreadable URL); `?method=GET&route=/v1/users` stays legible and
 * shareable.
 */
const endpointSearchSchema = Schema.Struct({
	method: Schema.String,
	route: Schema.String,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

type EndpointSearch = typeof endpointSearchSchema.Type

export const Route = createFileRoute("/services/$serviceName_/endpoints")({
	component: EndpointDetailPage,
	validateSearch: Schema.toStandardSchemaV1(endpointSearchSchema),
})

interface EndpointChartConfig {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
}

// Same four metrics as the service overview, so an endpoint reads as a smaller
// version of its service rather than a different kind of page.
const ENDPOINT_CHARTS: EndpointChartConfig[] = [
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

function EndpointDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<EndpointDetailContent />
		</PageRefreshProvider>
	)
}

function EndpointDetailContent() {
	const { serviceName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	// Every warehouse filter on this page keys on the display span name, which is
	// what the endpoints table stored before splitting it for display.
	const spanName = endpointSpanName(search.method, search.route)

	const handleTimeChange = useCallback(
		(
			range: { startTime?: string; endTime?: string; presetValue?: string },
			options?: { replace?: boolean },
		) => {
			navigate({
				replace: options?.replace,
				// Spread `prev` first: the endpoint identity is required search, so a
				// reducer that only returns time keys would drop method/route.
				search: (prev: EndpointSearch) => ({ ...prev, ...applyTimeRangeSearch(prev, range) }),
			})
		},
		[navigate],
	)

	const handleEnvironmentChange = useCallback(
		(environment: string | undefined) => {
			navigate({
				search: (prev: EndpointSearch) => ({
					...prev,
					environments: environment ? [environment] : undefined,
				}),
			})
		},
		[navigate],
	)

	const chartsAtom = getEndpointDetailChartsResultAtom({
		data: {
			serviceName,
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
			environments: search.environments,
			spanNames: [spanName],
		},
	})
	const chartsResult = useRetainedRefreshableResultValue(chartsAtom)
	const refreshCharts = useAtomRefresh(chartsAtom)

	const points: ReadonlyArray<ServiceDetailTimeSeriesPoint> = useMemo(
		() =>
			Result.builder(chartsResult)
				.onSuccess((r) => r.data)
				.orElse(() => []),
		[chartsResult],
	)

	// Widened to the generic record shape MetricsGrid consumes; every field on a
	// detail point is primitive, so this needs no `as unknown` round-trip.
	const chartPoints: Record<string, unknown>[] = useMemo(
		() => points.map((point) => ({ ...point })),
		[points],
	)

	const isChartsLoading = Result.isInitial(chartsResult)
	const isWaiting = Result.isSuccess(chartsResult) && chartsResult.waiting

	const metrics = useMemo(
		() =>
			ENDPOINT_CHARTS.map((chart) => ({
				id: chart.id,
				chartId: chart.chartId,
				title: chart.title,
				layout: chart.layout,
				data: chartPoints,
				legend: chart.legend,
				tooltip: chart.tooltip,
				rateMode: chart.rateMode,
				isLoading: isChartsLoading,
			})),
		[chartPoints, isChartsLoading],
	)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Services", href: "/services" },
					{ label: serviceName, href: `/services/${serviceName}` },
					{ label: "Endpoints", href: `/services/${serviceName}?tab=endpoints` },
					{ label: spanName },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<PageLayout.Title
									className="flex min-w-0 items-center gap-2.5"
									title={spanName}
								>
									<ServiceDot serviceName={serviceName} className="size-3" />
									<MethodBadge method={search.method} />
									{/* Same middle-elision as the table: the last segment is
									    what tells this endpoint apart from its siblings. */}
									<RouteLabel route={search.route} />
								</PageLayout.Title>
							}
						>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
						{Result.isFailure(chartsResult) ? (
							<QueryErrorState
								error={chartsResult.cause}
								titleOverride="Failed to load endpoint metrics"
								onRetry={refreshCharts}
							/>
						) : (
							<div className="flex flex-col gap-3">
								<MetricsGrid
									items={metrics}
									waiting={!!isWaiting}
									syncMode="cursor"
									syncId={`endpoint-${serviceName}-${spanName}`}
									// One y-axis width across the grid so the synced cursor
									// lines up, matching the service overview.
									yAxisWidth={72}
								/>
								<div className="grid gap-3 lg:grid-cols-2">
									<StatusBreakdownPanel
										serviceName={serviceName}
										spanName={spanName}
										effectiveStartTime={effectiveStartTime}
										effectiveEndTime={effectiveEndTime}
										environments={search.environments}
									/>
									<SlowTracesPanel
										serviceName={serviceName}
										spanName={spanName}
										effectiveStartTime={effectiveStartTime}
										effectiveEndTime={effectiveEndTime}
										environments={search.environments}
										startTime={search.startTime}
										endTime={search.endTime}
										timePreset={search.timePreset}
									/>
								</div>
							</div>
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

interface EndpointPanelProps {
	serviceName: string
	spanName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
}

/** Tailwind tint per status class — green through red, `unknown` neutral. */
const STATUS_TONE: Record<string, string> = {
	"1xx": "bg-muted-foreground/40",
	"2xx": "bg-severity-ok",
	"3xx": "bg-severity-info",
	"4xx": "bg-severity-warn",
	"5xx": "bg-severity-error",
	unknown: "bg-muted-foreground/30",
}

/**
 * Status-class split for this endpoint. Complements the error-rate chart above:
 * that says *when* it broke, this says *how* — a wall of 404s and a wall of 503s
 * are the same error rate and completely different problems.
 */
function StatusBreakdownPanel({
	serviceName,
	spanName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
}: EndpointPanelProps) {
	const result = useRetainedRefreshableResultValue(
		getEndpointStatusBreakdownResultAtom({
			data: {
				serviceName,
				spanName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				environments: environments?.length ? environments : undefined,
			},
		}),
	)

	const slices = Result.builder(result)
		.onSuccess((r) => r.slices)
		.orElse(() => [])

	if (Result.isInitial(result)) {
		return (
			<SectionCard title="Status codes">
				<div className="space-y-2 p-4">
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-2/3" />
				</div>
			</SectionCard>
		)
	}

	const total = slices.reduce((acc, slice) => acc + slice.estimatedSpanCount, 0)
	if (total === 0) {
		return (
			<SectionCard title="Status codes">
				<div className="px-4 py-6 text-center text-xs text-muted-foreground">
					No responses recorded in this window.
				</div>
			</SectionCard>
		)
	}

	return (
		<SectionCard
			title="Status codes"
			className={cn("transition-opacity", Result.isSuccess(result) && result.waiting && "opacity-60")}
		>
			<div className="space-y-3 p-4">
				{/* Single stacked bar: the proportions are the whole point, and a
				    100%-width row reads them faster than five separate bars. */}
				<div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
					{slices.map((slice) => (
						<div
							key={slice.statusClass}
							className={STATUS_TONE[slice.statusClass] ?? STATUS_TONE.unknown}
							style={{ width: `${(slice.estimatedSpanCount / total) * 100}%` }}
							title={`${slice.statusClass} — ${formatNumber(Math.round(slice.estimatedSpanCount))}`}
						/>
					))}
				</div>
				<ul className="space-y-1">
					{slices.map((slice) => (
						<li
							key={slice.statusClass}
							className="flex items-center gap-2 font-mono text-[12px] tabular-nums"
						>
							<span
								aria-hidden
								className={cn(
									"size-2 shrink-0 rounded-sm",
									STATUS_TONE[slice.statusClass] ?? STATUS_TONE.unknown,
								)}
							/>
							<span className="w-14 text-foreground">{slice.statusClass}</span>
							<span className="flex-1 text-muted-foreground/70">
								{((slice.estimatedSpanCount / total) * 100).toFixed(1)}%
							</span>
							<span className="text-muted-foreground">
								{slice.estimatedSpanCount > slice.spanCount ? "~" : ""}
								{formatNumber(Math.round(slice.estimatedSpanCount))}
							</span>
						</li>
					))}
				</ul>
			</div>
		</SectionCard>
	)
}

interface SlowTracesPanelProps extends EndpointPanelProps {
	startTime?: string
	endTime?: string
	timePreset?: string
}

/** The slowest individual requests to this endpoint, newest-first within the sort. */
function SlowTracesPanel({
	serviceName,
	spanName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: SlowTracesPanelProps) {
	const windowSecs =
		(Date.parse(effectiveEndTime.replace(" ", "T") + "Z") -
			Date.parse(effectiveStartTime.replace(" ", "T") + "Z")) /
		1000
	const detailLimited = windowSecs > TRACE_DETAIL_WINDOW_SECONDS
	const listStartTime = detailLimited
		? new Date(Date.parse(effectiveEndTime.replace(" ", "T") + "Z") - TRACE_DETAIL_WINDOW_SECONDS * 1000)
				.toISOString()
				.replace("T", " ")
				.slice(0, 19)
		: effectiveStartTime

	const result = useRetainedRefreshableResultValue(
		listTracesResultAtom({
			data: {
				services: [serviceName],
				spanNames: [spanName],
				deploymentEnvs: environments?.length ? environments : undefined,
				startTime: listStartTime,
				endTime: effectiveEndTime,
				// The endpoint's span is a server span, but not necessarily a trace
				// root (a gateway may sit in front), so search at span level.
				rootOnly: false,
				sortBy: "durationMs" as const,
				sortDir: "desc" as const,
				limit: SLOW_TRACES_LIMIT,
			},
		}),
	)

	const traces = Result.builder(result)
		.onSuccess((r) => r.data.slice(0, SLOW_TRACES_LIMIT))
		.orElse(() => [])

	return (
		<SectionCard
			title="Slowest requests"
			className={cn("transition-opacity", Result.isSuccess(result) && result.waiting && "opacity-60")}
			action={
				<div className="flex items-center gap-3">
					{detailLimited && (
						<span className="text-[11px] text-muted-foreground">Latest 30 days</span>
					)}
					<Link
						to="/traces"
						search={operationTraceSearch({
							serviceName,
							spanName,
							environments,
							startTime: detailLimited ? listStartTime : startTime,
							endTime: detailLimited ? effectiveEndTime : endTime,
							timePreset: detailLimited ? undefined : timePreset,
						})}
						className="text-xs text-primary hover:underline"
					>
						View all →
					</Link>
				</div>
			}
		>
			{Result.isInitial(result) ? (
				<div className="space-y-2 p-4">
					{Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className="h-6 w-full" />
					))}
				</div>
			) : traces.length === 0 ? (
				<div className="px-4 py-6 text-center text-xs text-muted-foreground">
					No traces recorded in this window.
				</div>
			) : (
				<ul className="space-y-px p-2">
					{traces.map((trace) => (
						<li key={`${trace.traceId}-${trace.spanId}`}>
							<Link
								to="/traces/$traceId"
								params={{ traceId: trace.traceId }}
								className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										trace.hasError ? "bg-severity-error" : "bg-severity-ok",
									)}
								/>
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
									{trace.traceId}
								</span>
								<LatencyValue ms={trace.durationMs} scale="p95" className="shrink-0" />
								<span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
									{formatRelativeTimeOrDate(trace.startTime)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</SectionCard>
	)
}
