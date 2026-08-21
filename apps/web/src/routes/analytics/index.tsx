import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result } from "@/lib/effect-atom"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"

import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { PlayRotateClockwiseIcon } from "@/components/icons"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import type { WebAnalyticsBreakdowns } from "@/api/warehouse/web-analytics"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	AnalyticsBreakdownPanel,
	type BreakdownDimension,
} from "@/components/analytics/analytics-breakdown-panel"
import { AnalyticsFilterSidebar } from "@/components/analytics/analytics-filter-sidebar"
import {
	AnalyticsMetricStrip,
	AnalyticsMetricStripLoading,
} from "@/components/analytics/analytics-metric-strip"
import { AnalyticsTrafficChart } from "@/components/analytics/analytics-traffic-chart"
import { Favicon } from "@/components/analytics/row-icon"
import {
	ANALYTICS_METRICS,
	findMetric,
	isMetricAvailable,
	type AnalyticsMetricDescriptor,
	type AnalyticsMetricKey,
	type AnalyticsMetricSource,
} from "@/components/analytics/metrics"
import { countryLabel, languageLabel, referrerLabel, utmLabel } from "@/components/analytics/labels"
import {
	activeFilterChips,
	analyticsFilterSearchFields,
	filtersFromSearch,
	toggleFilterValue,
	type AnalyticsFilterKey,
	type AnalyticsFilters,
} from "@/components/analytics/filters"
import {
	webAnalyticsBreakdownsResultAtom,
	webAnalyticsPagesResultAtom,
	webAnalyticsPageviewsResultAtom,
	webAnalyticsSummaryResultAtom,
	webAnalyticsTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { AnalyticsFunnelsView } from "@/components/funnels/analytics-funnels-view"
import {
	funnelFromSearch,
	funnelSearchFields,
	funnelToSearch,
	type AnalyticsView,
	type FunnelDefinition,
} from "@/components/funnels/definition"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const analyticsSearchSchema = Schema.Struct({
	...analyticsFilterSearchFields,
	...TimeRangeSearchFields,
	// `view` picks Overview or Funnels; the funnel definition rides in the URL
	// too so a funnel is a shareable link.
	...funnelSearchFields,
})

const DEFAULT_PRESET = "7d"
const PAGES_LIMIT = 100
const BREAKDOWN_LIMIT = 50

export const Route = createFileRoute("/analytics/")({
	component: WebAnalyticsPage,
	validateSearch: Schema.toStandardSchemaV1(analyticsSearchSchema),
})

function WebAnalyticsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const filters = filtersFromSearch(search)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	// Empty strings drop out of the URL entirely rather than lingering as `?country=`.
	const onFilterChange = (key: AnalyticsFilterKey, value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, [key]: value === "" ? undefined : value }) })
	}

	const onToggleFilter = (key: AnalyticsFilterKey, value: string) => {
		onFilterChange(key, toggleFilterValue(filters[key], value))
	}

	// Clearing filters keeps the view and the funnel: those are what you are
	// looking at, the filters are how narrowly.
	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				view: search.view,
				steps: search.steps,
				keyBy: search.keyBy,
				window: search.window,
				breakdown: search.breakdown,
			},
		})
	}

	const view: AnalyticsView = search.view ?? "overview"
	const onViewChange = (next: AnalyticsView) => {
		navigate({ search: (prev) => ({ ...prev, view: next === "overview" ? undefined : next }) })
	}

	const funnel = funnelFromSearch(search)
	// An edit per history entry would make Back useless while
	// typing an event name, so definition edits replace the current entry.
	const onFunnelChange = (definition: FunnelDefinition) => {
		navigate({ replace: true, search: (prev) => ({ ...prev, ...funnelToSearch(definition) }) })
	}

	// Retained, not bare: the filters are part of every atom key, so each row click
	// instantiates a fresh atom whose first emission is `Initial`. Reading that
	// directly would replace the sidebar with a skeleton on every click and reset
	// each section's open/search state — same reasoning as the Cloudflare pages.
	const breakdownsResult = useRetainedRefreshableResultValue(
		webAnalyticsBreakdownsResultAtom({
			data: { startTime, endTime, limitPerDimension: BREAKDOWN_LIMIT, ...filters },
		}),
	)

	const chips = activeFilterChips(filters)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Web Analytics" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<AnalyticsFilterSidebar
							breakdownsResult={breakdownsResult}
							filters={filters}
							onFilterChange={onFilterChange}
							onClearFilters={onClearFilters}
						/>
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								titleContent={
									<ToggleGroup
										value={[view]}
										onValueChange={(values) => {
											const next = values[0]
											if (next === "overview" || next === "funnels") onViewChange(next)
										}}
										variant="outline"
										size="sm"
										aria-label="Analytics view"
									>
										<ToggleGroupItem value="overview">Overview</ToggleGroupItem>
										<ToggleGroupItem value="funnels">Funnels</ToggleGroupItem>
									</ToggleGroup>
								}
							>
								<div className="flex flex-wrap items-center gap-2">
									{/* The reciprocal of the Analytics button on Session Replays: this
									    page aggregates the sessions that page plays back one at a time,
									    and "who are these people actually" is the next question from
									    either side. Carries the window across, same as the outbound link. */}
									<Button
										variant="outline"
										size="sm"
										aria-label="View session replays"
										render={
											<Link
												to="/replays"
												search={{
													startTime: search.startTime,
													endTime: search.endTime,
													timePreset: search.timePreset,
												}}
											/>
										}
									>
										<PlayRotateClockwiseIcon size={14} />
										<span className="hidden sm:inline">Replays</span>
									</Button>
									<TimeRangeHeaderControls
										startTime={search.startTime ?? startTime}
										endTime={search.endTime ?? endTime}
										presetValue={
											search.timePreset ??
											(search.startTime ? undefined : DEFAULT_PRESET)
										}
										onTimeChange={handleTimeChange}
									/>
								</div>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title={view === "funnels" ? "Funnels" : "Web Analytics"}
									description={
										view === "funnels"
											? "How many people made it from one step to the next — page views, track() events and server-side events, stitched per person."
											: "Who visited your sites, what they read, and where they came from — from the same browser SDK that records sessions."
									}
									meta={
										chips.length > 0 ? (
											<div className="flex flex-wrap items-center gap-1.5">
												{chips.map((chip) => (
													<button
														key={`${chip.key}:${chip.value}`}
														type="button"
														onClick={() => onFilterChange(chip.key, undefined)}
														className="rounded-sm border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
													>
														{chip.label} ✕
													</button>
												))}
												<button
													type="button"
													onClick={onClearFilters}
													className="px-1 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
												>
													Clear all
												</button>
											</div>
										) : undefined
									}
								/>
								{view === "funnels" ? (
									<AnalyticsFunnelsView
										startTime={startTime}
										endTime={endTime}
										filters={filters}
										definition={funnel}
										onDefinitionChange={onFunnelChange}
									/>
								) : (
									<AnalyticsContent
										startTime={startTime}
										endTime={endTime}
										filters={filters}
										breakdownsResult={breakdownsResult}
										onToggleFilter={onToggleFilter}
									/>
								)}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/**
 * The metric drawn alongside the selected one, when it declares a companion and
 * that companion actually reports something.
 *
 * The availability check is the load-bearing half. Visitors and page views pair
 * with each other, but visitors come from the migration-0011 analytics block —
 * on an org whose SDK build predates it, selecting Page views would otherwise
 * draw a second series flat along the axis and label it "Unique visitors", which
 * reads as "nobody visited" rather than "not reported".
 */
function pairedCompanion(
	metric: AnalyticsMetricDescriptor,
	source: AnalyticsMetricSource,
): AnalyticsMetricDescriptor | undefined {
	if (!metric.companion) return undefined
	const companion = findMetric(metric.companion)
	return isMetricAvailable(companion, source) ? companion : undefined
}

/**
 * The window immediately before this one, of the same length — the baseline the
 * KPI deltas are measured against. "Last 7 days" compares against the 7 days
 * before it, which is what makes a delta answer "is this better than usual".
 */
function previousWindow(startTime: string, endTime: string) {
	const start = parseWarehouseDateTime(startTime)
	const end = parseWarehouseDateTime(endTime)
	const span = end - start
	return {
		startTime: formatWarehouseDateTime(start - span),
		endTime: startTime,
	}
}

function AnalyticsContent({
	startTime,
	endTime,
	filters,
	breakdownsResult,
	onToggleFilter,
}: {
	startTime: string
	endTime: string
	filters: AnalyticsFilters
	breakdownsResult: Result.Result<WebAnalyticsBreakdowns, QueryAtomFailure>
	onToggleFilter: (key: AnalyticsFilterKey, value: string) => void
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const windowInput = { startTime, endTime, ...filters }
	const previous = previousWindow(startTime, endTime)
	const previousInput = { ...previous, ...filters }

	// `null` means "nobody has picked yet", which is deliberately distinct from
	// "picked Unique visitors" — the strip's leading metric is visitor-level, and
	// on an org whose SDK build predates the analytics block it is unavailable.
	// Seeding it as the default put a flat-zero line under a headline reading "—".
	// Resolved during render rather than seeded into state, for the same reason
	// the breakdown panel derives its first populated tab: availability depends on
	// the window and the filters, both of which change under the selection.
	//
	// Local state, not a search param: which metric you are looking at is a view
	// preference, and putting it in the URL would attach it to every shared link
	// and every back-button step.
	const [picked, setPicked] = useState<AnalyticsMetricKey | null>(null)

	const summaryResult = useRetainedRefreshableResultValue(
		webAnalyticsSummaryResultAtom({ data: windowInput }),
	)
	const timeseriesResult = useRetainedRefreshableResultValue(
		webAnalyticsTimeseriesResultAtom({ data: { ...windowInput, bucketSeconds } }),
	)
	const pageviewsResult = useRetainedRefreshableResultValue(
		webAnalyticsPageviewsResultAtom({ data: { ...windowInput, bucketSeconds } }),
	)
	const pagesResult = useRetainedRefreshableResultValue(
		webAnalyticsPagesResultAtom({ data: { ...windowInput, limit: PAGES_LIMIT } }),
	)

	// The comparison window. Two queries rather than one because Page views and
	// Pages / session are measured over `session_events`, which the summary query
	// deliberately does not read — without the second, those two tiles would be
	// the only ones with no delta.
	const previousSummaryResult = useRetainedRefreshableResultValue(
		webAnalyticsSummaryResultAtom({ data: previousInput }),
	)
	const previousPageviewsResult = useRetainedRefreshableResultValue(
		webAnalyticsPageviewsResultAtom({ data: { ...previousInput, bucketSeconds } }),
	)

	const timeseries = Result.builder(timeseriesResult)
		.onSuccess((rows) => rows.data)
		.orElse(() => [])
	const pageviews = Result.builder(pageviewsResult)
		.onSuccess((rows) => rows.data)
		.orElse(() => [])

	// The comparison is strictly decorative: a slow or failed baseline query drops
	// the delta pills and leaves every headline number intact.
	const previousSource: AnalyticsMetricSource | undefined = Result.builder(previousSummaryResult)
		.onSuccess((summary) => ({
			summary,
			timeseries: [],
			pageviews: Result.builder(previousPageviewsResult)
				.onSuccess((rows) => rows.data)
				.orElse(() => []),
		}))
		.orElse(() => undefined)

	return (
		<div className="space-y-6">
			{Result.builder(summaryResult)
				.onInitial(() => (
					<>
						<AnalyticsMetricStripLoading />
						<Skeleton className="h-56 w-full" />
					</>
				))
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((summary) => {
					const source: AnalyticsMetricSource = { summary, timeseries, pageviews }
					// An explicit pick wins while it still holds; a filter change that
					// empties it falls back rather than drawing a line along the axis.
					const pickedMetric = picked ? findMetric(picked) : undefined
					const metric =
						pickedMetric && isMetricAvailable(pickedMetric, source)
							? pickedMetric
							: (ANALYTICS_METRICS.find((candidate) => isMetricAvailable(candidate, source)) ??
								ANALYTICS_METRICS[0]!)

					return (
						<>
							<AnalyticsMetricStrip
								source={source}
								previous={previousSource}
								selected={metric.key}
								onSelect={setPicked}
							/>
							<AnalyticsTrafficChart
								metric={metric}
								companion={pairedCompanion(metric, source)}
								source={source}
								syncId="web-analytics"
							/>
						</>
					)
				})
				.render()}

			{Result.builder(breakdownsResult)
				.onInitial(() => (
					<div className="grid gap-4 @min-[880px]/page:grid-cols-2">
						<Skeleton className="h-72 w-full" />
						<Skeleton className="h-72 w-full" />
					</div>
				))
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((breakdowns, result) => {
					const pages = Result.builder(pagesResult)
						.onSuccess((rows) => rows.data)
						.orElse(() => [])
					// One site is the common case, and then the favicon is the same mark on
					// every row — noise. It earns its place only once two sites can share
					// a path, which is exactly when the path alone stops identifying a row.
					const multiSite = new Set(pages.map((page) => page.host)).size > 1

					const referrers: ReadonlyArray<BreakdownDimension> = [
						{
							tab: "Referrers",
							rows: breakdowns.referrerHosts,
							filterKey: "referrerHost",
							noun: "referrer",
							nounPlural: "referrers",
							formatValue: referrerLabel,
						},
						{
							tab: "UTM source",
							rows: breakdowns.utmSources,
							filterKey: "utmSource",
							noun: "source",
							nounPlural: "sources",
							formatValue: utmLabel,
						},
						{
							tab: "Medium",
							rows: breakdowns.utmMediums,
							filterKey: "utmMedium",
							noun: "medium",
							nounPlural: "mediums",
							formatValue: utmLabel,
						},
						{
							tab: "Campaign",
							rows: breakdowns.utmCampaigns,
							filterKey: "utmCampaign",
							noun: "campaign",
							nounPlural: "campaigns",
							formatValue: utmLabel,
						},
					]

					const pageDimensions: ReadonlyArray<BreakdownDimension> = [
						{
							tab: "Pages",
							// The one dimension with a real page-view count, and the only one
							// on the page with full coverage — it reads `session_events`,
							// which every SDK build writes. Entries and Exits beside it come
							// from the analytics block and do not.
							rows: pages.map((page) => ({
								name: page.pagePath,
								count: page.sessions,
								views: page.pageViews,
								secondary: page.host,
							})),
							filterKey: "pagePath",
							noun: "page",
							nounPlural: "pages",
							renderIcon: multiSite
								? (row) => <Favicon host={row.secondary ?? ""} />
								: undefined,
							emptyMessage: "No page views in the selected window.",
						},
						{
							tab: "Entries",
							rows: breakdowns.entryPaths,
							filterKey: "pagePath",
							noun: "entry page",
							nounPlural: "entry pages",
						},
						{
							tab: "Exits",
							rows: breakdowns.exitPaths,
							filterKey: "pagePath",
							noun: "exit page",
							nounPlural: "exit pages",
						},
					]

					const devices: ReadonlyArray<BreakdownDimension> = [
						{
							tab: "Devices",
							rows: breakdowns.deviceTypes,
							filterKey: "deviceType",
							noun: "device",
							nounPlural: "devices",
						},
						{
							tab: "Browsers",
							rows: breakdowns.browsers,
							filterKey: "browserName",
							noun: "browser",
							nounPlural: "browsers",
						},
						{
							tab: "OS",
							rows: breakdowns.operatingSystems,
							filterKey: "osName",
							noun: "OS",
							nounPlural: "operating systems",
						},
					]

					const geography: ReadonlyArray<BreakdownDimension> = [
						{
							tab: "Countries",
							rows: breakdowns.countries,
							filterKey: "country",
							noun: "country",
							nounPlural: "countries",
							formatValue: countryLabel,
							// Geo is derived at the ingest gateway from Cf-IPCountry and only
							// when it is configured to trust that header. Say so, rather than
							// letting an empty list read as "nobody visited".
							emptyMessage:
								"No geo data. Country is resolved at the ingest gateway from the Cloudflare edge header, and only for traffic received after that was enabled — it is never backfilled.",
						},
						{
							tab: "Languages",
							rows: breakdowns.languages,
							filterKey: "language",
							noun: "language",
							nounPlural: "languages",
							formatValue: languageLabel,
						},
						{
							tab: "Sites",
							rows: breakdowns.hosts,
							filterKey: "host",
							noun: "site",
							nounPlural: "sites",
						},
					]

					// `items-start` so each card sizes to its own content instead of
					// stretching to match the tallest in its row — a Devices card with
					// three rows should not be as tall as a Pages card with fifty.
					const cards: ReadonlyArray<{
						/** Names the theme the tabs share; carried only as a stable key. */
						id: string
						dimensions: ReadonlyArray<BreakdownDimension>
					}> = [
						{ id: "acquisition", dimensions: referrers },
						{ id: "content", dimensions: pageDimensions },
						{ id: "technology", dimensions: devices },
						{ id: "audience", dimensions: geography },
					]

					return (
						<div className="grid items-start gap-4 @min-[880px]/page:grid-cols-2">
							{cards.map((card) => (
								<AnalyticsBreakdownPanel
									key={card.id}
									dimensions={card.dimensions}
									activeValue={(key) => filters[key]}
									onToggleFilter={onToggleFilter}
									waiting={result.waiting}
								/>
							))}
						</div>
					)
				})
				.render()}
		</div>
	)
}
