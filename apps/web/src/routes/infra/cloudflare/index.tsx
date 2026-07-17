import { useMemo } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { CloudflareIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { CloudflareKpiCards, CloudflareKpiCardsLoading } from "@/components/infra/cloudflare/cloudflare-kpi-cards"
import { CloudflareNotConnected } from "@/components/infra/cloudflare/cloudflare-not-connected"
import { CloudflarePlatformSection } from "@/components/infra/cloudflare/cloudflare-platform-table"
import { CloudflareWorkerTable, CloudflareWorkerTableLoading } from "@/components/infra/cloudflare/cloudflare-worker-table"
import { CloudflareZoneChart } from "@/components/infra/cloudflare/cloudflare-zone-chart"
import { CloudflareZoneTable, CloudflareZoneTableLoading } from "@/components/infra/cloudflare/cloudflare-zone-table"
import { COLOR_PALETTE } from "@/components/infra/chart-utils"
import {
	OTHER_ZONES_COLOR,
	chartBucketSeconds,
} from "@/components/infra/cloudflare/constants"
import {
	cloudflareWorkersResultAtom,
	cloudflareZonesResultAtom,
	cloudflareZoneTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const cloudflareSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/infra/cloudflare/"))({
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
	// the org has the Cloudflare integration connected with analytics scopes.
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Cloudflare" }]}
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime ?? startTime}
						endTime={search.endTime ?? endTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
						onTimeChange={handleTimeChange}
					/>
				}
			>
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
							if (!status.connected) return <CloudflareNotConnected variant="not-connected" />
							if (!status.analyticsCapable) {
								return <CloudflareNotConnected variant="needs-permissions" />
							}
							return <CloudflareData startTime={startTime} endTime={endTime} />
						})
						.render()}
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}

function CloudflareData({ startTime, endTime }: { startTime: string; endTime: string }) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)

	const zonesResult = useAtomValue(cloudflareZonesResultAtom({ data: { startTime, endTime } }))
	const timeseriesResult = useAtomValue(
		cloudflareZoneTimeseriesResultAtom({ data: { startTime, endTime, bucketSeconds } }),
	)
	const workersResult = useAtomValue(cloudflareWorkersResultAtom({ data: { startTime, endTime } }))

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
		const top = ordered.slice(0, COLOR_PALETTE.length)
		return { top, otherCount: ordered.length - top.length }
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
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CloudflareIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>No Cloudflare traffic in this window</EmptyTitle>
					<EmptyDescription>
						Analytics ingest in 5-minute batches shortly after the integration connects. Widen
						the time range or check back in a few minutes.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="space-y-6">
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
						<div className={`space-y-6 content-enter ${result.waiting ? "opacity-60" : ""}`}>
							{response.zones.length > 0 && (
								<CloudflareKpiCards zones={response.zones} buckets={timeseries?.buckets} />
							)}
							{response.zones.length > 0 && timeseries && timeseries.buckets.length > 0 && zoneSeries && (
								<div className="space-y-2">
									{(zoneSeries.top.length > 1 || zoneSeries.otherCount > 0) && (
										<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
											{zoneSeries.top.map((name, idx) => (
												<Link
													key={name}
													to="/infra/cloudflare/$zoneName"
													params={{ zoneName: name }}
													className="group inline-flex items-center gap-1.5"
												>
													<span
														aria-hidden
														className="size-1.5 rounded-full"
														style={{ background: COLOR_PALETTE[idx % COLOR_PALETTE.length] }}
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
							<section className="space-y-3">
								<h2 className="text-sm font-medium text-foreground">
									Zones
									<span className="ml-2 font-mono text-xs text-muted-foreground">
										{response.zones.length}
									</span>
								</h2>
								<CloudflareZoneTable zones={response.zones} waiting={result.waiting} />
							</section>
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
