import { useMemo } from "react"
import { Line, LineChart } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
	ChartGrid,
	ChartXAxis,
	ChartYAxis,
} from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/lib/utils"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import type { CloudflareZoneTimeseriesRow } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@maple/ui/lib/format"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { CHART_EMPTY_MESSAGE, makeBucketLabeler, transformRows } from "../chart-utils"
import { OTHER_ZONES_COLOR, OTHER_ZONES_SERIES } from "./constants"

export type CloudflareZoneMetric = "requests" | "errorRate" | "cacheHitRate" | "bytes"

const METRIC_LABELS: Record<CloudflareZoneMetric, string> = {
	requests: "Edge requests",
	errorRate: "5xx error rate",
	cacheHitRate: "Cache hit rate",
	bytes: "Bandwidth",
} satisfies Record<CloudflareZoneMetric, string>

const CHART_HEIGHT = 200

function formatMetricValue(value: number, metric: CloudflareZoneMetric): string {
	if (metric === "errorRate" || metric === "cacheHitRate") return formatPercent(value)
	if (metric === "bytes") return formatBytes(value)
	return formatNumber(value)
}

interface CloudflareZoneChartProps {
	buckets: ReadonlyArray<CloudflareZoneTimeseriesRow>
	metric: CloudflareZoneMetric
	/**
	 * Zones plotted as individual lines, hottest first (at most
	 * `MAX_ZONE_SERIES`). Colors come from the shared identity hash, so a zone
	 * matches its legend chip in the route. Everything else pools into "Other zones".
	 */
	topZones: ReadonlyArray<string>
	waiting?: boolean
	syncId?: string
}

interface ZoneAgg {
	requests: number
	errors5xx: number
	cacheHits: number
	bytes: number
}

function metricValue(agg: ZoneAgg, metric: CloudflareZoneMetric): number {
	if (metric === "errorRate") return agg.requests > 0 ? agg.errors5xx / agg.requests : 0
	if (metric === "cacheHitRate") return agg.requests > 0 ? agg.cacheHits / agg.requests : 0
	return agg[metric]
}

/**
 * One line per top zone. Count metrics (`requests`/`bytes`) plot the sums
 * directly; ratio metrics derive the per-bucket ratio so zones stay comparable
 * regardless of traffic volume. The "Other zones" remainder aggregates raw
 * counts per bucket first and derives ratios from the pooled counts — never an
 * average of ratios.
 */
export function CloudflareZoneChart({
	buckets,
	metric,
	topZones,
	waiting,
	syncId,
}: CloudflareZoneChartProps) {
	const { data, series } = useMemo(() => {
		const topSet = new Set(topZones)
		const byBucketZone = new Map<string, Map<string, ZoneAgg>>()
		for (const row of buckets) {
			const zone = topSet.has(row.zoneName) ? row.zoneName : OTHER_ZONES_SERIES
			let zoneMap = byBucketZone.get(row.bucket)
			if (!zoneMap) {
				zoneMap = new Map()
				byBucketZone.set(row.bucket, zoneMap)
			}
			const agg = zoneMap.get(zone) ?? { requests: 0, errors5xx: 0, cacheHits: 0, bytes: 0 }
			agg.requests += row.requests
			agg.errors5xx += row.errors5xx
			agg.cacheHits += row.cacheHits
			agg.bytes += row.bytes
			zoneMap.set(zone, agg)
		}
		const longForm: Array<{ bucket: string; attributeValue: string; value: number }> = []
		for (const [bucket, zoneMap] of byBucketZone) {
			for (const [zone, agg] of zoneMap) {
				longForm.push({ bucket, attributeValue: zone, value: metricValue(agg, metric) })
			}
		}
		const labeler = makeBucketLabeler([...byBucketZone.keys()])
		const transformed = transformRows(longForm, labeler)
		// Draw order = legend order: hottest zone first, the pooled remainder last.
		const present = new Set(transformed.series)
		const ordered = [
			...topZones.filter((z) => present.has(z)),
			...(present.has(OTHER_ZONES_SERIES) ? [OTHER_ZONES_SERIES] : []),
		]
		return { data: transformed.data, series: ordered }
	}, [buckets, metric, topZones])

	// Zone names contain dots (`example.com`), which are invalid in a raw
	// `var(--color-…)` reference — colour series directly instead of via the
	// ChartContainer CSS variables.
	const seriesColor = useMemo(() => {
		const map = resolveSeriesColors(topZones)
		map.set(OTHER_ZONES_SERIES, OTHER_ZONES_COLOR)
		return map
	}, [topZones])

	const config = useMemo<ChartConfig>(
		() => Object.fromEntries(series.map((name) => [name, { label: name, color: seriesColor.get(name) }])),
		[series, seriesColor],
	)

	return (
		<div className={cn("rounded-md border bg-card transition-opacity", waiting && "opacity-60")}>
			<div className="flex items-center justify-between px-3 pt-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">{METRIC_LABELS[metric]}</span>
			</div>
			{data.length === 0 ? (
				<div
					className="flex items-center justify-center font-mono text-[11px] text-muted-foreground"
					style={{ height: CHART_HEIGHT }}
				>
					{CHART_EMPTY_MESSAGE}
				</div>
			) : (
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					<LineChart
						data={data}
						margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
						syncId={syncId}
						syncMethod="value"
					>
						<ChartGrid />
						<ChartXAxis
							dataKey="time"
						/>
						<ChartYAxis
							tickMargin={8}
							width={52}
							tickFormatter={(v: number) => formatMetricValue(v, metric)}
						/>
						<ChartTooltip
							itemSorter={(item) => -Number(item.value ?? 0)}
							content={
								<ChartTooltipContent
									indicator="dot"
									formatter={(value, name) => (
										<>
											<div
												className="size-2.5 shrink-0 rounded-[2px]"
												style={{ background: seriesColor.get(String(name)) }}
											/>
											<div className="flex flex-1 items-center justify-between gap-3 leading-none">
												<span className="text-muted-foreground">{String(name)}</span>
												<span className="font-mono font-medium tabular-nums text-foreground">
													{formatMetricValue(Number(value), metric)}
												</span>
											</div>
										</>
									)}
								/>
							}
						/>
						{series.map((s) => (
							<Line
								key={s}
								type="monotone"
								dataKey={s}
								stroke={seriesColor.get(s)}
								strokeWidth={1.5}
								dot={false}
								isAnimationActive={false}
							/>
						))}
					</LineChart>
				</ChartContainer>
			)}
		</div>
	)
}
