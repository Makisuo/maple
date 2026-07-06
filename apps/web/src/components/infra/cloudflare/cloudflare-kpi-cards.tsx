import { useMemo } from "react"

import type { CloudflareZoneRow, CloudflareZoneTimeseriesRow } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@/lib/format"
import { formatPercent } from "../format"
import { StatRail, StatRailItem, StatRailLoading } from "../primitives/stat-rail"
import { formatBytes } from "./format"

interface CloudflareKpiCardsProps {
	zones: ReadonlyArray<CloudflareZoneRow>
	/** Per-zone buckets; aggregated across zones here for the sparklines. */
	buckets?: ReadonlyArray<CloudflareZoneTimeseriesRow>
}

export { StatRailLoading as CloudflareKpiCardsLoading }

export function CloudflareKpiCards({ zones, buckets }: CloudflareKpiCardsProps) {
	const totals = useMemo(() => {
		let requests = 0
		let errors5xx = 0
		let cacheHits = 0
		let bytes = 0
		for (const zone of zones) {
			requests += zone.requests
			errors5xx += zone.errors5xx
			cacheHits += zone.cacheHits
			bytes += zone.bytes
		}
		return {
			requests,
			bytes,
			errorRate: requests > 0 ? errors5xx / requests : 0,
			cacheHitRate: requests > 0 ? cacheHits / requests : 0,
		}
	}, [zones])

	const sparks = useMemo(() => {
		if (!buckets?.length) return undefined
		const byBucket = new Map<string, { requests: number; errors5xx: number; cacheHits: number; bytes: number }>()
		for (const row of buckets) {
			const agg = byBucket.get(row.bucket) ?? { requests: 0, errors5xx: 0, cacheHits: 0, bytes: 0 }
			agg.requests += row.requests
			agg.errors5xx += row.errors5xx
			agg.cacheHits += row.cacheHits
			agg.bytes += row.bytes
			byBucket.set(row.bucket, agg)
		}
		const ordered = [...byBucket.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)
		return {
			requests: ordered.map((v) => v.requests),
			errorRate: ordered.map((v) => (v.requests > 0 ? v.errors5xx / v.requests : 0)),
			cacheHitRate: ordered.map((v) => (v.requests > 0 ? v.cacheHits / v.requests : 0)),
			bytes: ordered.map((v) => v.bytes),
		}
	}, [buckets])

	return (
		<StatRail>
			<StatRailItem
				eyebrow="Edge requests"
				value={formatNumber(totals.requests)}
				spark={sparks?.requests}
			/>
			<StatRailItem
				eyebrow="5xx error rate"
				value={formatPercent(totals.errorRate)}
				tone={totals.errorRate >= 0.05 ? "crit" : totals.errorRate >= 0.01 ? "warn" : "neutral"}
				spark={sparks?.errorRate}
			/>
			<StatRailItem
				eyebrow="Cache hit rate"
				value={formatPercent(totals.cacheHitRate)}
				spark={sparks?.cacheHitRate}
			/>
			<StatRailItem eyebrow="Bandwidth" value={formatBytes(totals.bytes)} spark={sparks?.bytes} />
		</StatRail>
	)
}
