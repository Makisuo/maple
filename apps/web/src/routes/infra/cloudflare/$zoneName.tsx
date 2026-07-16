import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { CloudflareIcon } from "@/components/icons"
import { HeroChip, PageHero } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { formatPercent } from "@/components/infra/format"
import { formatBytes } from "@/components/infra/cloudflare/format"
import { CloudflareEdgeShareBand } from "@/components/infra/cloudflare/cloudflare-edge-share-band"
import {
	CloudflareZoneCacheChart,
	CloudflareZoneLatencyChart,
	CloudflareZoneStatusChart,
} from "@/components/infra/cloudflare/cloudflare-zone-detail-charts"
import { CloudflareTopTrafficCard } from "@/components/infra/cloudflare/cloudflare-top-traffic-card"
import { CloudflareZoneDnsSection } from "@/components/infra/cloudflare/cloudflare-zone-dns"
import { CloudflareZoneHostsSection } from "@/components/infra/cloudflare/cloudflare-zone-hosts"
import { CloudflareZoneSecuritySection } from "@/components/infra/cloudflare/cloudflare-zone-security"
import { chartBucketSeconds, errorRateTone } from "@/components/infra/cloudflare/constants"
import {
	cloudflareZoneDetailResultAtom,
	cloudflareZonesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const zoneDetailSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/infra/cloudflare/$zoneName"))({
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

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "Cloudflare", href: "/infra/cloudflare" },
					{ label: zoneName },
				]}
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
						title={zoneName}
						description="How the edge answered this zone's traffic — status mix, cache behavior, and latency percentiles where your plan exposes them."
						trailing={<HeroChip>zone</HeroChip>}
					/>
					<ZoneDetailContent zoneName={zoneName} startTime={startTime} endTime={endTime} />
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}

function ZoneDetailContent({
	zoneName,
	startTime,
	endTime,
}: {
	zoneName: string
	startTime: string
	endTime: string
}) {
	const serviceName = `${ZONE_SERVICE_PREFIX}${zoneName}`
	const bucketSeconds = chartBucketSeconds(startTime, endTime)

	const detailResult = useAtomValue(
		cloudflareZoneDetailResultAtom({
			data: { serviceName, startTime, endTime, bucketSeconds },
		}),
	)
	// The list rollup carries the bytes/visits/latency KPIs; picking this
	// zone's row client-side shares the 30s-cached atom with the list page.
	const zonesResult = useAtomValue(cloudflareZonesResultAtom({ data: { startTime, endTime } }))
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
				return (
					<Empty className="py-16 content-enter">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<CloudflareIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No traffic for this zone in the selected window</EmptyTitle>
							<EmptyDescription>
								Widen the time range, or check the zone list for where traffic is landing.
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
				<div className={`space-y-6 content-enter ${result.waiting ? "opacity-60" : ""}`}>
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
						<CloudflareZoneStatusChart buckets={detail.statusBuckets} syncId="cf-zone-detail" />
						<CloudflareZoneCacheChart buckets={detail.cacheBuckets} syncId="cf-zone-detail" />
					</div>
					<CloudflareZoneLatencyChart buckets={detail.latencyBuckets} syncId="cf-zone-detail" />
					{/* Extended sections load independently and hide themselves when their
					    dataset is absent for this zone (plan/config-dependent). */}
					<CloudflareZoneHostsSection
						serviceName={serviceName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						syncId="cf-zone-detail"
					/>
					<CloudflareTopTrafficCard zoneName={zoneName} startTime={startTime} endTime={endTime} />
					<CloudflareZoneSecuritySection
						serviceName={serviceName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						syncId="cf-zone-detail"
					/>
					<CloudflareZoneDnsSection
						serviceName={serviceName}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
						syncId="cf-zone-detail"
					/>
				</div>
			)
		})
		.render()
}
