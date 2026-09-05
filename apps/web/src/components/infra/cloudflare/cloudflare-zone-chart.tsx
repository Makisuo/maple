import { useMemo } from "react"

import { d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	linearYDomain,
	niceLinearDomain,
	useResolvedSeriesColors,
	usePlotChromeColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"
import { linkedCursorChartProps } from "@/hooks/use-linked-cursor"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import type { CloudflareZoneTimeseriesRow } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@maple/ui/lib/format"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { CHART_EMPTY_MESSAGE, makeBucketAxis, transformRows, type TransformedPoint } from "../chart-utils"
import { CHART_HEIGHT, ChartCardMessage } from "../primitives/chart-card"
import { OTHER_ZONES_COLOR, OTHER_ZONES_SERIES } from "./constants"

export type CloudflareZoneMetric = "requests" | "errorRate" | "cacheHitRate" | "bytes"

const METRIC_LABELS: Record<CloudflareZoneMetric, string> = {
	requests: "Edge requests",
	errorRate: "5xx error rate",
	cacheHitRate: "Cache hit rate",
	bytes: "Bandwidth",
} satisfies Record<CloudflareZoneMetric, string>

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
		const transformed = transformRows(longForm)
		// Draw order = legend order: hottest zone first, the pooled remainder last.
		const present = new Set(transformed.series)
		const ordered = [
			...topZones.filter((z) => present.has(z)),
			...(present.has(OTHER_ZONES_SERIES) ? [OTHER_ZONES_SERIES] : []),
		]
		// Cloudflare emits no row for a zone with no traffic in a bucket, so a hole
		// is a zero reading — a null would break the line into fragments instead.
		for (const point of transformed.data) {
			for (const name of ordered) point[name] ??= 0
		}
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

	// Resolved to literals: canvas cannot read `var(--chart-3)`.
	const chromeColors = usePlotChromeColors()
	const colors = useResolvedSeriesColors(seriesColor, chromeColors.border)
	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	// A time axis over the buckets' instants — see `makeBucketAxis` for why the
	// label point scale this replaced folded a 24h window onto itself.
	const axis = useMemo(() => makeBucketAxis(data.map((point) => point.bucket)), [data])

	const yDomain = useMemo<[number, number]>(
		() => niceLinearDomain(linearYDomain({ rows: data, keys: series })),
		[data, series],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<TransformedPoint>[]>(
		() =>
			series.map((name) => ({
				label: name,
				color: colors.get(name) ?? chromeColors.border,
				value: (point: TransformedPoint) => {
					const value = point[name]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatMetricValue(value, metric),
			})),
		[series, colors, chromeColors.border, metric],
	)

	const definition = useMemo(() => {
		const at = (point: TransformedPoint) => point.date
		const valueOf = (name: string) => (point: TransformedPoint) => {
			const value = point[name]
			return typeof value === "number" ? value : null
		}
		const colorOf = (name: string) => colors.get(name) ?? chromeColors.border

		return defineChart({
			marks: [
				dashedGridY(),
				...series.map((name) =>
					lineY(data, {
						id: name,
						x: at,
						y: valueOf(name),
						stroke: colorOf(name),
						strokeWidth: 1.5,
						curve: d3Curve(curveMonotoneX),
					}),
				),
				...series.map((name) => focusDot(data, at, valueOf(name), colorOf(name), chromeColors)),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: axis.x,
				y: {
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: (v: number) => formatMetricValue(v, metric) },
					},
				},
			},
			// `left` pinned so the four zone charts share a plot edge, wide enough for
			// the byte labels. `bottom` stays unset: a set side is a hard lock, and the
			// frame only reserves the x tick labels' height when it measures the side.
			margin: { top: 12, right: 12, left: 60 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [data, series, axis, colors, chromeColors, yDomain, metric, focusStore])

	return (
		<div
			className={cn("rounded-md border bg-card transition-opacity", waiting && "opacity-60")}
			// `syncId` used to be handed to Recharts' hover-sync event bus. The linked
			// cursor replaced that (CSS variables on a container, no React state), so
			// it now names this chart within its group.
			{...linkedCursorChartProps(syncId != null ? `cf-zone-${metric}` : undefined)}
		>
			<div className="flex items-center justify-between px-3 pt-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">{METRIC_LABELS[metric]}</span>
			</div>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<div className="w-full" style={{ height: CHART_HEIGHT }}>
					<PlotFrame
						definition={definition}
						ariaLabel={METRIC_LABELS[metric]}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(point: TransformedPoint) => axis.heading(point.bucket)}
							/>
						)}
					/>
				</div>
			)}
		</div>
	)
}
