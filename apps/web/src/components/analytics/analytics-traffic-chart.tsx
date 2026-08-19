import { useMemo } from "react"
import { areaY, d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { curveMonotoneX } from "d3-shape"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	resolvePlotColor,
	useChartId,
	usePlotChromeColors,
	verticalGradient,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { linkedCursorChartProps } from "@/hooks/use-linked-cursor"

import { CHART_EMPTY_MESSAGE, makeBucketLabeler } from "../infra/chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../infra/primitives/chart-card"
import type { AnalyticsMetricDescriptor, AnalyticsMetricSource } from "./metrics"

// The page's one accent, same as the KPI sparklines (`SPARK_COLOR.neutral`) and
// the row bars (`shareBar`). Deliberately not `--chart-1`, which is this same
// amber only in the dark theme and a blue in the light one — the chart would
// have disagreed with the tile that selected it, at half of all page loads.
const PRIMARY_TOKEN = "--primary"
const PRIMARY_FALLBACK = "#6366f1"

/** The designated second-series token: cool against the accent in both themes. */
const COMPANION_TOKEN = "--chart-2"
const COMPANION_FALLBACK = "#22d3ee"

/** Series keys. Fixed, so the tooltip can map a row back to its descriptor. */
const PRIMARY = "primary"
const COMPANION = "companion"

interface AnalyticsTrafficChartProps {
	/** The metric selected in the KPI strip. Supplies the series and its formatting. */
	metric: AnalyticsMetricDescriptor
	/**
	 * `metric.companion`, resolved and already checked for availability. Plotted on
	 * the same axes; omitted when the pair's other half reports nothing.
	 */
	companion?: AnalyticsMetricDescriptor
	source: AnalyticsMetricSource
	syncId?: string
}

/** One bucket, carrying whichever of the two series reported there. */
interface TrafficPoint {
	label: string
	primary?: number
	companion?: number
}

/**
 * The selected metric over time, with its companion beside it where it has one.
 *
 * Most metrics draw alone: the strip is the legend, and putting a rate and a
 * count on one axis would make both unreadable. Visitors and page views are the
 * exception, and the reason this chart exists — "how many people" against "how
 * much they read" is the comparison the page is opened for, and neither number
 * means much without the other.
 *
 * That pair is deliberately **not stacked**, and the visitors area paints over
 * the page-view area rather than under it. The two come from different tables
 * with different coverage, so reading visitors as a subset of page views is the
 * correct reading; reading their sum as anything is not.
 *
 * Buckets are outer-joined on the union of both series' timestamps, so a window
 * where one table has data and the other doesn't shows a gap in one line rather
 * than shifting the other sideways.
 */
export function AnalyticsTrafficChart({ metric, companion, source, syncId }: AnalyticsTrafficChartProps) {
	const gradientPrefix = useChartId("traffic")
	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	// Tokens resolved to literals: canvas cannot read `var()`, and `useTheme` is
	// the invalidation key that repaints them when the theme flips.
	const { theme } = useTheme()
	const colors = useMemo(
		() => ({
			primary: resolvePlotColor(PRIMARY_TOKEN, PRIMARY_FALLBACK),
			companion: resolvePlotColor(COMPANION_TOKEN, COMPANION_FALLBACK),
		}),
		[theme],
	)

	const { data, totals } = useMemo(() => {
		const primaryPoints = metric.series(source)
		const companionPoints = companion?.series(source) ?? []

		const byBucket = new Map<string, { primary?: number; companion?: number }>()
		for (const point of primaryPoints) {
			byBucket.set(point.bucket, { ...byBucket.get(point.bucket), primary: point.value })
		}
		for (const point of companionPoints) {
			byBucket.set(point.bucket, { ...byBucket.get(point.bucket), companion: point.value })
		}

		const buckets = [...byBucket.keys()].sort()
		const label = makeBucketLabeler(buckets)
		return {
			data: buckets.map((bucket) => ({ label: label(bucket), ...byBucket.get(bucket)! })),
			totals: {
				primary: primaryPoints.reduce((sum, point) => sum + point.value, 0),
				companion: companionPoints.reduce((sum, point) => sum + point.value, 0),
			},
		}
	}, [metric, companion, source])

	// Selected metric first — this order is the legend's, where it should lead.
	const series = [
		{ key: PRIMARY, descriptor: metric, color: colors.primary, total: totals.primary },
		...(companion
			? [
					{
						key: COMPANION,
						descriptor: companion,
						color: colors.companion,
						total: totals.companion,
					},
				]
			: []),
	]

	// Painting order is by magnitude, not by selection: the bigger area is laid
	// down first so the smaller one sits on top of it. Both areas are filled, so
	// drawing page views over visitors would bury the visitors series completely —
	// and which of the pair is selected must not decide whether you can see the
	// other one.
	const painted = [...series].sort((a, b) => b.total - a.total)

	const tooltipSeries = useMemo<PlotTooltipSeries<TrafficPoint>[]>(
		() =>
			series.map((entry) => ({
				label: entry.descriptor.label,
				color: entry.color,
				value: (point: TrafficPoint) => {
					const value = point[entry.key as "primary" | "companion"]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => entry.descriptor.format(value),
			})),
		// `series` is rebuilt every render (it is a plain array, not memoised), so
		// this depends on the inputs behind it rather than on its identity.
		[metric, companion, colors, totals],
	)

	const definition = useMemo(() => {
		const at = (point: TrafficPoint) => point.label
		// A bucket one table has and the other doesn't is a gap, not a zero —
		// joining across it would draw a dip that never happened, which is what
		// `connectNulls={false}` said.
		const valueOf = (key: string) => (point: TrafficPoint) => {
			const value = point[key as "primary" | "companion"]
			return typeof value === "number" ? value : null
		}
		const curve = d3Curve(curveMonotoneX)

		return defineChart({
			gradients: painted.map((entry) =>
				verticalGradient(`${gradientPrefix}-${entry.key}`, entry.color, 0.35, 0.02),
			),
			marks: [
				dashedGridY(),
				// Painting order is by magnitude — see `painted`. Each series is a
				// filled band plus its own edge line, which is what one Recharts
				// `<Area stroke fill>` drew.
				...painted.flatMap((entry) => [
					areaY(data, {
						id: `${entry.key}-band`,
						x: at,
						y: valueOf(entry.key),
						y1: () => 0,
						fill: `url(#${gradientPrefix}-${entry.key})`,
						stroke: "none",
						curve,
					}),
					lineY(data, {
						id: entry.key,
						x: at,
						y: valueOf(entry.key),
						stroke: entry.color,
						strokeWidth: 1.5,
						curve,
					}),
				]),
				...painted.map((entry) => focusDot(data, at, valueOf(entry.key), entry.color, chromeColors)),
				focusCrosshair(chromeColors),
			],
			x: {
				scale: scalePoint,
				axis: {
					line: false,
					ticks: { size: 0, padding: 8 },
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				scale: scaleLinear,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						// The metric formatters render a zero *headline* as "—" ("no
						// session ended", not "0s"). On an axis that reading is wrong —
						// the baseline is a real zero — so it is spelled out here.
						format: (value: number) => (value === 0 ? "0" : metric.format(value)),
					},
				},
			},
			margin: { left: 52, right: 8, top: 4, bottom: 0 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [data, painted, gradientPrefix, chromeColors, metric, focusStore])

	// Only when there are two series to tell apart — a lone series is already
	// named by the card title, and a legend restating it is one accessory too many.
	const legend = companion ? (
		<>
			{series.map((entry) => (
				<span key={entry.key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span
						aria-hidden
						className="size-1.5 rounded-full"
						style={{ backgroundColor: entry.color }}
					/>
					{entry.descriptor.label}
					<span className="font-mono tabular-nums text-muted-foreground/70">
						{entry.descriptor.format(entry.total)}
					</span>
				</span>
			))}
		</>
	) : undefined

	return (
		<ChartCard
			title={companion ? `${metric.label} & ${companion.label.toLowerCase()}` : metric.label}
			legend={legend}
		>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<div
					className="w-full"
					style={{ height: CHART_HEIGHT }}
					// `syncId` drove Recharts' hover-sync event bus; the linked cursor
					// replaced it (CSS variables on a container, no React state), and
					// this names the chart within that group.
					{...linkedCursorChartProps(syncId != null ? `analytics-${metric.label}` : undefined)}
				>
					<PlotFrame
						definition={definition}
						ariaLabel={metric.label}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(point: TrafficPoint) => point.label}
							/>
						)}
					/>
				</div>
			)}
		</ChartCard>
	)
}
