import { useDeferredValue, useMemo, useState, type ReactNode } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { CloudflareIcon, MagnifierIcon, XmarkIcon } from "@/components/icons"
import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { PageHero } from "@/components/infra/primitives/page-hero"
import {
	CloudflareKpiCards,
	CloudflareKpiCardsLoading,
} from "@/components/infra/cloudflare/cloudflare-kpi-cards"
import {
	CloudflareIngestBanner,
	CloudflareIngestEmpty,
	CloudflareStalledAction,
} from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { CloudflareNotConnected } from "@/components/infra/cloudflare/cloudflare-not-connected"
import { CloudflarePlatformSection } from "@/components/infra/cloudflare/cloudflare-platform-table"
import {
	CloudflareWorkerTable,
	CloudflareWorkerTableLoading,
} from "@/components/infra/cloudflare/cloudflare-worker-table"
import { CloudflareZoneChart } from "@/components/infra/cloudflare/cloudflare-zone-chart"
import {
	CloudflareZoneTable,
	CloudflareZoneTableLoading,
} from "@/components/infra/cloudflare/cloudflare-zone-table"
import { MAX_ZONE_SERIES, OTHER_ZONES_COLOR } from "@/components/infra/cloudflare/constants"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflareWorkersResultAtom,
	cloudflareZonesResultAtom,
	cloudflareZoneTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import type { CloudflareIngestPhase } from "@/components/infra/cloudflare/ingest-phase"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const cloudflareSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/cloudflare/")({
	component: CloudflarePage,
	validateSearch: Schema.toStandardSchemaV1(cloudflareSearchSchema),
})

function CloudflarePage() {
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
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	// Integration-gated (not infra-agent-gated): the page is useful exactly when
	// the org has the Cloudflare integration connected with analytics scopes. The hook also
	// carries the ingest phase, and polls while a fresh connection is still filling up.
	const { statusResult, phase } = useCloudflareIngestPhase()

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Infrastructure", href: "/infra" }, { label: "Cloudflare" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="Cloudflare"
									description="Edge analytics from the Cloudflare integration — per-zone HTTP traffic, cache performance, and Workers invocations."
								/>
								{Result.builder(statusResult)
									.onInitial(() => (
										<div className="space-y-4">
											<Skeleton className="h-28 w-full" />
											<Skeleton className="h-64 w-full" />
										</div>
									))
									.onError((err) => <QueryErrorState error={err} />)
									.onSuccess((status) => {
										if (!status.connected)
											return <CloudflareNotConnected variant="not-connected" />
										if (!status.analyticsCapable) {
											return <CloudflareNotConnected variant="needs-permissions" />
										}
										return (
											<CloudflareData
												startTime={startTime}
												endTime={endTime}
												phase={phase}
											/>
										)
									})
									.render()}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

function CloudflareData({
	startTime,
	endTime,
	phase,
}: {
	startTime: string
	endTime: string
	phase: CloudflareIngestPhase | null
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)

	// Retained so a manual refresh or a time-range nudge fades the current numbers instead of
	// replacing the whole page with skeletons; it also wires these atoms to PageRefreshProvider.
	const zonesResult = useRefreshableAtomValue(cloudflareZonesResultAtom({ data: { startTime, endTime } }))
	const timeseriesResult = useRefreshableAtomValue(
		cloudflareZoneTimeseriesResultAtom({ data: { startTime, endTime, bucketSeconds } }),
	)
	const workersResult = useRefreshableAtomValue(
		cloudflareWorkersResultAtom({ data: { startTime, endTime } }),
	)
	const [zoneFilter, setZoneFilter] = useState("")
	const zoneQuery = useDeferredValue(zoneFilter).trim().toLowerCase()

	const timeseries = Result.builder(timeseriesResult)
		.onSuccess((r) => r)
		.orElse(() => null)
	const timeseriesWaiting = Result.builder(timeseriesResult)
		.onSuccess((_, holder) => Boolean(holder.waiting))
		.orElse(() => false)

	// Stable zone→color assignment shared by all four charts and the legend:
	// zones ordered by window request volume, capped at the palette size, the
	// remainder pooled into one muted "Other zones" series.
	const zoneSeries = useMemo(() => {
		if (!timeseries) return null
		const totals = new Map<string, number>()
		for (const row of timeseries.buckets) {
			totals.set(row.zoneName, (totals.get(row.zoneName) ?? 0) + row.requests)
		}
		const ordered = [...totals.entries()].toSorted((a, b) => b[1] - a[1]).map(([name]) => name)
		const top = ordered.slice(0, MAX_ZONE_SERIES)
		return { top, otherCount: ordered.length - top.length, colors: resolveSeriesColors(top) }
	}, [timeseries])

	// Zones (HTTP edge analytics) and Workers (invocation analytics) are
	// independent datasets — an org can have either without the other. The
	// page-level "no traffic" empty state only applies when BOTH are settled
	// and empty; otherwise each section shows its own lightweight empty.
	const zonesEmpty = Result.builder(zonesResult)
		.onSuccess((r, holder) => r.zones.length === 0 && !holder.waiting)
		.orElse(() => false)
	const workersEmpty = Result.builder(workersResult)
		.onSuccess((r, holder) => r.workers.length === 0 && !holder.waiting)
		.orElse(() => false)

	if (zonesEmpty && workersEmpty) {
		// Two different empties wear the same face otherwise: a connection that has never
		// produced anything (say why, and when to expect it) versus a live one whose selected
		// window happens to be quiet (say that, and offer the fix — a wider window).
		if (phase != null && phase.kind !== "live" && phase.kind !== "backfilling") {
			return (
				<CloudflareIngestEmpty phase={phase}>
					{phase.kind === "stalled" ? <CloudflareStalledAction /> : null}
				</CloudflareIngestEmpty>
			)
		}
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CloudflareIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>No Cloudflare traffic in this window</EmptyTitle>
					<EmptyDescription>
						This zone set reported no requests over the selected range. Widen the time range, or
						check back once more traffic has been collected.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="space-y-6">
			{phase == null ? null : <CloudflareIngestBanner phase={phase} />}
			{Result.builder(zonesResult)
				.onInitial(() => (
					<div className="space-y-4">
						<CloudflareKpiCardsLoading />
						<CloudflareZoneTableLoading />
					</div>
				))
				.onError((err) => <QueryErrorState error={err} />)
				.onSuccess((response, result) => {
					return (
						<div className={`space-y-6 transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
							{response.zones.length > 0 && (
								<CloudflareKpiCards zones={response.zones} buckets={timeseries?.buckets} />
							)}
							{response.zones.length > 0 &&
								timeseries &&
								timeseries.buckets.length > 0 &&
								zoneSeries && (
									<div className="space-y-2">
										{(zoneSeries.top.length > 1 || zoneSeries.otherCount > 0) && (
											<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
												{zoneSeries.top.map((name) => (
													<Link
														key={name}
														to="/infra/cloudflare/$zoneName"
														params={{ zoneName: name }}
														className="group inline-flex items-center gap-1.5"
													>
														<span
															aria-hidden
															className="size-1.5 rounded-full"
															style={{
																background: zoneSeries.colors.get(name),
															}}
														/>
														<span className="text-[11px] text-muted-foreground transition-colors group-hover:text-foreground">
															{name}
														</span>
													</Link>
												))}
												{zoneSeries.otherCount > 0 && (
													<span className="inline-flex items-center gap-1.5">
														<span
															aria-hidden
															className="size-1.5 rounded-full"
															style={{ background: OTHER_ZONES_COLOR }}
														/>
														<span className="text-[11px] text-muted-foreground">
															Other zones ({zoneSeries.otherCount})
														</span>
													</span>
												)}
											</div>
										)}
										<div className="grid gap-4 lg:grid-cols-2">
											<CloudflareZoneChart
												buckets={timeseries.buckets}
												metric="requests"
												topZones={zoneSeries.top}
												waiting={timeseriesWaiting}
												syncId="cf-zones"
											/>
											<CloudflareZoneChart
												buckets={timeseries.buckets}
												metric="errorRate"
												topZones={zoneSeries.top}
												waiting={timeseriesWaiting}
												syncId="cf-zones"
											/>
											<CloudflareZoneChart
												buckets={timeseries.buckets}
												metric="cacheHitRate"
												topZones={zoneSeries.top}
												waiting={timeseriesWaiting}
												syncId="cf-zones"
											/>
											<CloudflareZoneChart
												buckets={timeseries.buckets}
												metric="bytes"
												topZones={zoneSeries.top}
												waiting={timeseriesWaiting}
												syncId="cf-zones"
											/>
										</div>
									</div>
								)}
							<ZonesSection zones={response.zones} query={zoneQuery} waiting={result.waiting}>
								<SectionFilter
									value={zoneFilter}
									onChange={setZoneFilter}
									placeholder={`Filter ${response.zones.length} zones`}
									label="Filter zones by name"
								/>
							</ZonesSection>
						</div>
					)
				})
				.render()}
			<section className="space-y-3">
				<h2 className="text-sm font-medium text-foreground">
					Workers
					{Result.builder(workersResult)
						.onSuccess((r) => (
							<span className="ml-2 font-mono text-xs text-muted-foreground">
								{r.workers.length}
							</span>
						))
						.orElse(() => null)}
				</h2>
				{Result.builder(workersResult)
					.onInitial(() => <CloudflareWorkerTableLoading />)
					.onError((err) => <QueryErrorState error={err} />)
					.onSuccess((response, result) => (
						<CloudflareWorkerTable workers={response.workers} waiting={result.waiting} />
					))
					.render()}
			</section>
			<CloudflarePlatformSection startTime={startTime} endTime={endTime} />
		</div>
	)
}

/**
 * The zone list is capped by the server at 500, not by anything human. Filtering by name beats
 * scrolling for it, and the count reads `shown of total` so a filtered view never looks like the
 * whole picture.
 */
function ZonesSection({
	zones,
	query,
	waiting,
	children,
}: {
	zones: ReadonlyArray<CloudflareZoneRow>
	query: string
	waiting?: boolean
	children: ReactNode
}) {
	const matches = useMemo(
		() => (query === "" ? zones : zones.filter((zone) => zone.zoneName.toLowerCase().includes(query))),
		[zones, query],
	)

	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<h2 className="text-sm font-medium text-foreground">
					Zones
					<span className="ml-2 font-mono text-xs text-muted-foreground">
						{matches.length === zones.length
							? zones.length
							: `${matches.length} of ${zones.length}`}
					</span>
				</h2>
				{zones.length > 1 ? children : null}
			</div>
			<CloudflareZoneTable
				zones={matches}
				waiting={waiting}
				emptyMessage={query === "" ? undefined : `No zones match "${query}" in the selected window.`}
			/>
		</section>
	)
}

/** Compact filter field for a section header. Same chrome as the breakdown panel's toolbar. */
function SectionFilter({
	value,
	onChange,
	placeholder,
	label,
}: {
	value: string
	onChange: (value: string) => void
	placeholder: string
	label: string
}) {
	return (
		<label className="flex h-6 w-56 items-center gap-1.5 rounded-sm border border-border/70 bg-background/60 px-2 transition-colors focus-within:border-ring">
			<MagnifierIcon size={11} className="shrink-0 text-muted-foreground" />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				aria-label={label}
				className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{value ? (
				<button
					type="button"
					onClick={() => onChange("")}
					aria-label="Clear filter"
					className="shrink-0 rounded-xs p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
				>
					<XmarkIcon size={9} />
				</button>
			) : null}
		</label>
	)
}
