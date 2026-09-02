import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { CloudflareIcon } from "@/components/icons"
import { HeroChip, PageHero } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { CloudflareBreakdownPanel } from "@/components/infra/cloudflare/cloudflare-breakdown-panel"
import {
	CloudflareIngestEmpty,
	CloudflareStalledAction,
} from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import { CloudflareEdgeShareBand } from "@/components/infra/cloudflare/cloudflare-edge-share-band"
import { CloudflareFilterChips } from "@/components/infra/cloudflare/cloudflare-filter-chips"
import { CloudflareFilterSidebarView } from "@/components/infra/cloudflare/cloudflare-filter-sidebar"
import {
	CloudflareZoneCacheChart,
	CloudflareZoneLatencyChart,
	CloudflareZoneStatusChart,
} from "@/components/infra/cloudflare/cloudflare-zone-detail-charts"
import { CloudflareZoneDnsSection } from "@/components/infra/cloudflare/cloudflare-zone-dns"
import { CloudflareZoneSecuritySection } from "@/components/infra/cloudflare/cloudflare-zone-security"
import { PanelScope } from "@/components/infra/cloudflare/panel-scope"
import {
	cloudflareFilterSearchFields,
	filtersFromSearch,
	toggleFilterValue,
	type ActiveFilterChip,
	type CloudflareFilterKey,
	type CloudflareFilters,
} from "@/components/infra/cloudflare/filters"
import { errorRateTone } from "@/components/infra/cloudflare/constants"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflareZoneDetailResultAtom,
	cloudflareZoneFacetsResultAtom,
	cloudflareZonesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const zoneDetailSearchSchema = Schema.Struct({
	...cloudflareFilterSearchFields,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/cloudflare/$zoneName")({
	component: ZoneDetailPage,
	validateSearch: Schema.toStandardSchemaV1(zoneDetailSearchSchema),
})

const ZONE_SERVICE_PREFIX = "cloudflare/"

function ZoneDetailPage() {
	const { zoneName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)
	const serviceName = `${ZONE_SERVICE_PREFIX}${zoneName}`
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

	// Empty selections drop out of the URL entirely rather than lingering as `?paths=[]`.
	const onFilterChange = <K extends keyof CloudflareFilters>(key: K, value: CloudflareFilters[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onToggleFilter = (key: CloudflareFilterKey, value: string) => {
		if (key === "pathContains") return
		navigate({
			search: (prev) => ({
				...prev,
				[key]: toggleFilterValue(filters[key], value),
			}),
		})
	}

	const onRemoveChip = (chip: ActiveFilterChip) => {
		if (chip.key === "pathContains") {
			navigate({ search: (prev) => ({ ...prev, pathContains: undefined }) })
			return
		}
		onToggleFilter(chip.key, chip.value)
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

	// Retained, not bare: the selected filters are part of the atom key, so every checkbox toggle
	// instantiates a fresh atom whose first emission is `Initial`. Reading that directly replaced the
	// whole sidebar with a skeleton on each click and reset every section's open/search/show-all
	// state. Retaining the last success keeps the sections in place and merely dims the counts.
	const facetsResult = useRefreshableAtomValue(
		cloudflareZoneFacetsResultAtom({ data: { serviceName, startTime, endTime, ...filters } }),
	)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Cloudflare", href: "/infra/cloudflare" },
						{ label: zoneName },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<CloudflareFilterSidebarView
							facetsResult={facetsResult}
							filters={filters}
							onFilterChange={onFilterChange}
							onClearFilters={onClearFilters}
						/>
					</DashboardLayout.Filters>
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
									title={zoneName}
									description="How the edge answered this zone's traffic — status mix, cache behavior, and latency percentiles where your plan exposes them."
									trailing={<HeroChip>zone</HeroChip>}
									meta={
										<CloudflareFilterChips
											filters={filters}
											onRemove={onRemoveChip}
											onClear={onClearFilters}
										/>
									}
								/>
								<ZoneDetailContent
									zoneName={zoneName}
									serviceName={serviceName}
									startTime={startTime}
									endTime={endTime}
									filters={filters}
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

function ZoneDetailContent({
	zoneName,
	serviceName,
	startTime,
	endTime,
	filters,
	onToggleFilter,
}: {
	zoneName: string
	serviceName: string
	startTime: string
	endTime: string
	filters: CloudflareFilters
	onToggleFilter: (key: CloudflareFilterKey, value: string) => void
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	// A zone drilled into before any data has been collected would otherwise read as "this zone
	// has no traffic", which is a different — and wrong — thing to tell someone.
	const { phase } = useCloudflareIngestPhase()

	const detailResult = useRefreshableAtomValue(
		cloudflareZoneDetailResultAtom({
			data: { serviceName, startTime, endTime, bucketSeconds, ...filters },
		}),
	)
	// The list rollup carries the bytes/visits/latency KPIs; picking this
	// zone's row client-side shares the 30s-cached atom with the list page.
	const zonesResult = useRefreshableAtomValue(
		cloudflareZonesResultAtom({ data: { startTime, endTime, ...filters } }),
	)
	const zoneRow = Result.builder(zonesResult)
		.onSuccess((r) => r.zones.find((zone) => zone.serviceName === serviceName) ?? null)
		.orElse(() => null)

	return Result.builder(detailResult)
		.onInitial(() => (
			<div className="space-y-6">
				<StatRailLoading />
				<Skeleton className="h-28 w-full" />
				<div className="grid gap-4 lg:grid-cols-2">
					<Skeleton className="h-56 w-full" />
					<Skeleton className="h-56 w-full" />
				</div>
			</div>
		))
		.onError((err) => <QueryErrorState error={err} />)
		.onSuccess((detail, result) => {
			if (detail.statusBuckets.length === 0 && !result.waiting) {
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
							<EmptyTitle>No traffic for this zone in the selected window</EmptyTitle>
							<EmptyDescription>
								Widen the time range, clear the filters, or check the zone list for where
								traffic is landing.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)
			}

			const requests = detail.statusBuckets.reduce((acc, b) => acc + b.requests, 0)
			const errors5xx = detail.statusBuckets.reduce(
				(acc, b) => acc + (b.statusClass === "5xx" ? b.requests : 0),
				0,
			)
			const errorRate = requests > 0 ? errors5xx / requests : 0

			return (
				<div className={`space-y-6 transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
					<StatRail>
						<StatRailItem eyebrow="Edge requests" value={formatNumber(requests)} compact />
						<StatRailItem
							eyebrow="5xx error rate"
							value={formatPercent(errorRate)}
							tone={errorRateTone(errorRate)}
							compact
						/>
						<StatRailItem
							eyebrow="Bandwidth"
							value={zoneRow ? formatBytes(zoneRow.bytes) : "—"}
							compact
						/>
						<StatRailItem
							eyebrow="Visits"
							value={zoneRow ? formatNumber(zoneRow.visits) : "—"}
							compact
						/>
					</StatRail>
					<CloudflareEdgeShareBand cacheBuckets={detail.cacheBuckets} />
					<div className="grid gap-4 lg:grid-cols-2">
						<CloudflareZoneStatusChart
							buckets={detail.statusBuckets}
							syncId="cf-zone-detail"
							scope={
								<PanelScope
									filters={filters}
									ignoredFilters={detail.ignoredFilters}
									reason="This chart is grouped by status class"
								/>
							}
						/>
						<CloudflareZoneCacheChart
							buckets={detail.cacheBuckets}
							syncId="cf-zone-detail"
							scope={
								<PanelScope
									filters={filters}
									ignoredFilters={detail.ignoredFilters}
									reason="This chart is grouped by cache status"
								/>
							}
						/>
					</div>
					<CloudflareZoneLatencyChart
						buckets={detail.latencyBuckets}
						syncId="cf-zone-detail"
						scope={
							<PanelScope
								filters={filters}
								ignoredFilters={detail.latencyIgnoredFilters}
								reason="Cloudflare reports latency percentiles for the whole zone"
							/>
						}
					/>
					<CloudflareBreakdownPanel
						serviceName={serviceName}
						zoneName={zoneName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						filters={filters}
						onToggleFilter={onToggleFilter}
						syncId="cf-zone-detail"
					/>
					{/* Extended sections load independently and hide themselves when their
					    dataset is absent for this zone (plan/config-dependent). */}
					<CloudflareZoneSecuritySection
						serviceName={serviceName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						filters={filters}
						syncId="cf-zone-detail"
					/>
					<CloudflareZoneDnsSection
						serviceName={serviceName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						filters={filters}
						syncId="cf-zone-detail"
					/>
				</div>
			)
		})
		.render()
}
