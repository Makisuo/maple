import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { PlayRotateClockwiseIcon } from "@/components/icons"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import type { WebAnalyticsBreakdowns, WebAnalyticsSummary } from "@/api/warehouse/web-analytics"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	AnalyticsBreakdownPanel,
	type BreakdownDimension,
} from "@/components/analytics/analytics-breakdown-panel"
import { AnalyticsFilterSidebar } from "@/components/analytics/analytics-filter-sidebar"
import { AnalyticsPagesPanel } from "@/components/analytics/analytics-pages-panel"
import { AnalyticsTrafficChart } from "@/components/analytics/analytics-traffic-chart"
import { countryLabel, languageLabel } from "@/components/analytics/labels"
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
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const analyticsSearchSchema = Schema.Struct({
	...analyticsFilterSearchFields,
	...TimeRangeSearchFields,
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

	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
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
							<DashboardLayout.Header>
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
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="Web Analytics"
									description="Who visited your sites, what they read, and where they came from — from the same browser SDK that records sessions."
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
								<AnalyticsContent
									startTime={startTime}
									endTime={endTime}
									filters={filters}
									breakdownsResult={breakdownsResult}
									onToggleFilter={onToggleFilter}
								/>
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
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

	return (
		<div className="space-y-6">
			<SummaryRail result={summaryResult} />

			{Result.builder(timeseriesResult)
				.onInitial(() => <Skeleton className="h-56 w-full" />)
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((visitors) => (
					<AnalyticsTrafficChart
						visitorPoints={visitors.data}
						pageviewPoints={Result.builder(pageviewsResult)
							.onSuccess((views) => views.data)
							.orElse(() => [])}
						syncId="web-analytics"
					/>
				))
				.render()}

			{Result.builder(pagesResult)
				.onInitial(() => <Skeleton className="h-72 w-full" />)
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((pages, result) => (
					<AnalyticsPagesPanel
						pages={pages.data}
						selectedPath={filters.pagePath}
						onTogglePath={(pagePath) => onToggleFilter("pagePath", pagePath)}
						waiting={result.waiting}
						showHost={new Set(pages.data.map((page) => page.host)).size > 1}
					/>
				))
				.render()}

			{Result.builder(breakdownsResult)
				.onInitial(() => (
					<div className="grid gap-4 lg:grid-cols-2">
						<Skeleton className="h-72 w-full" />
						<Skeleton className="h-72 w-full" />
					</div>
				))
				.onError((error) => <QueryErrorState error={error} />)
				.onSuccess((breakdowns, result) => {
					const coverageNote = Result.builder(summaryResult)
						.onSuccess((summary) => {
							if (summary.sessions === 0 || summary.coverage >= 0.98) return undefined
							if (summary.identifiedSessions === 0) {
								return "No session in this window reports this dimension — it needs an SDK build that sends the analytics fields."
							}
							return `This dimension covers ${formatPercent(summary.coverage)} of sessions; the rest predate the SDK's analytics fields.`
						})
						.orElse(() => undefined)

					const acquisition: ReadonlyArray<BreakdownDimension> = [
						{
							tab: "Referrers",
							rows: breakdowns.referrerHosts,
							filterKey: "referrerHost",
							noun: "referrer",
							nounPlural: "referrers",
							coverageDependent: true,
							emptyMessage:
								"No referrers recorded. Sessions with an empty referrer are excluded rather than bucketed as direct — an empty value also covers internal navigation and Referrer-Policy suppression.",
						},
						{
							tab: "UTM source",
							rows: breakdowns.utmSources,
							filterKey: "utmSource",
							noun: "source",
							nounPlural: "sources",
							coverageDependent: true,
						},
						{
							tab: "Medium",
							rows: breakdowns.utmMediums,
							filterKey: "utmMedium",
							noun: "medium",
							nounPlural: "mediums",
							coverageDependent: true,
						},
						{
							tab: "Campaign",
							rows: breakdowns.utmCampaigns,
							filterKey: "utmCampaign",
							noun: "campaign",
							nounPlural: "campaigns",
							coverageDependent: true,
						},
						{
							tab: "Entry page",
							rows: breakdowns.entryPaths,
							filterKey: "pagePath",
							noun: "page",
							nounPlural: "pages",
							coverageDependent: true,
						},
						{
							tab: "Exit page",
							rows: breakdowns.exitPaths,
							filterKey: "pagePath",
							noun: "page",
							nounPlural: "pages",
							coverageDependent: true,
						},
					]

					const audience: ReadonlyArray<BreakdownDimension> = [
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
						{
							tab: "Languages",
							rows: breakdowns.languages,
							filterKey: "language",
							noun: "language",
							nounPlural: "languages",
							coverageDependent: true,
							formatValue: languageLabel,
						},
						{
							tab: "Sites",
							rows: breakdowns.hosts,
							filterKey: "host",
							noun: "site",
							nounPlural: "sites",
							coverageDependent: true,
						},
					]

					return (
						<div className="grid gap-4 lg:grid-cols-2">
							<AnalyticsBreakdownPanel
								title="Acquisition"
								dimensions={acquisition}
								activeValue={(key) => filters[key]}
								onToggleFilter={onToggleFilter}
								waiting={result.waiting}
								footnote={coverageNote}
							/>
							<AnalyticsBreakdownPanel
								title="Audience"
								dimensions={audience}
								activeValue={(key) => filters[key]}
								onToggleFilter={onToggleFilter}
								waiting={result.waiting}
								footnote={coverageNote}
							/>
						</div>
					)
				})
				.render()}
		</div>
	)
}

const formatDuration = (ms: number): string => {
	if (ms <= 0) return "—"
	const seconds = Math.round(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

function SummaryRail({ result }: { result: Result.Result<WebAnalyticsSummary, QueryAtomFailure> }) {
	return Result.builder(result)
		.onInitial(() => <StatRailLoading />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((summary) => {
			// Nothing in this window reports the analytics block, so every
			// visitor-level number would be a confident-looking zero. Say "not
			// reported" instead — sessions and page views are still real, and the
			// panels below still work.
			const identified = summary.identifiedSessions > 0
			const partial = identified && summary.coverage < 0.98
			const coverageNote = partial
				? `${formatPercent(summary.coverage)} of sessions report one`
				: undefined

			return (
				<StatRail>
					<StatRailItem
						eyebrow="Unique visitors"
						value={identified ? formatNumber(summary.visitors) : "—"}
						compact
						subline={identified ? coverageNote : "No session reports a visitor id"}
					/>
					<StatRailItem
						eyebrow="Sessions"
						value={formatNumber(summary.sessions)}
						compact
						subline={identified ? `${formatNumber(summary.newSessions)} first-time` : undefined}
					/>
					<StatRailItem
						eyebrow="Bounce rate"
						value={summary.bounceRate === null ? "—" : formatPercent(summary.bounceRate)}
						compact
						subline={
							summary.bounceRate === null
								? "Needs per-session page-view counts"
								: `One page view or fewer, of ${formatNumber(summary.identifiedSessions)} reporting sessions`
						}
					/>
					<StatRailItem
						eyebrow="Avg. session"
						value={formatDuration(summary.avgDurationMs)}
						compact
						subline="Wall clock, sessions that ended"
					/>
				</StatRail>
			)
		})
		.render()
}
