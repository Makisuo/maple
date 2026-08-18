import { useId, useMemo } from "react"
import { Area, AreaChart } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
	ChartGrid,
	ChartXAxis,
	ChartYAxis,
} from "@maple/ui/components/ui/chart"

import { CHART_EMPTY_MESSAGE, makeBucketLabeler } from "../infra/chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../infra/primitives/chart-card"
import type { AnalyticsMetricDescriptor, AnalyticsMetricSource } from "./metrics"

// The page's one accent, same as the KPI sparklines (`SPARK_COLOR.neutral`) and
// the row bars (`shareBar`). Deliberately not `--chart-1`, which is this same
// amber only in the dark theme and a blue in the light one — the chart would
// have disagreed with the tile that selected it, at half of all page loads.
const PRIMARY_COLOR = "var(--primary)"

/** The designated second-series token: cool against the accent in both themes. */
const COMPANION_COLOR = "var(--chart-2)"

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
	const gradientPrefix = useId().replace(/:/g, "")

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

	const config = useMemo(
		() =>
			({
				[PRIMARY]: { label: metric.label, color: PRIMARY_COLOR },
				...(companion
					? { [COMPANION]: { label: companion.label, color: COMPANION_COLOR } }
					: undefined),
			}) satisfies ChartConfig,
		[metric.label, companion],
	)

	// Selected metric first — this order is the legend's, where it should lead.
	const series = [
		{ key: PRIMARY, descriptor: metric, color: PRIMARY_COLOR, total: totals.primary },
		...(companion
			? [{ key: COMPANION, descriptor: companion, color: COMPANION_COLOR, total: totals.companion }]
			: []),
	]

	// Painting order is by magnitude, not by selection: the bigger area is laid
	// down first so the smaller one sits on top of it. Both areas are filled, so
	// drawing page views over visitors would bury the visitors series completely —
	// and which of the pair is selected must not decide whether you can see the
	// other one.
	const painted = [...series].sort((a, b) => b.total - a.total)

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
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					<AreaChart data={data} syncId={syncId} syncMethod="value" margin={{ left: 4, right: 8 }}>
						<defs>
							{series.map((entry) => (
								<linearGradient
									key={entry.key}
									id={`${gradientPrefix}-${entry.key}`}
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop offset="0%" stopColor={entry.color} stopOpacity={0.35} />
									<stop offset="100%" stopColor={entry.color} stopOpacity={0.02} />
								</linearGradient>
							))}
						</defs>
						<ChartGrid />
						<ChartXAxis dataKey="label" className="text-[10px]" />
						<ChartYAxis
							width={52}
							// The metric formatters render a zero *headline* as "—" ("no
							// session ended", not "0s"). On an axis that reading is wrong —
							// the baseline is a real zero — so it is spelled out here.
							tickFormatter={(value: number) => (value === 0 ? "0" : metric.format(value))}
							className="text-[10px]"
						/>
						{/* `formatter` replaces the whole tooltip row, not just the number,
						    so the swatch and label are rebuilt here — otherwise a metric
						    like Bounce rate would render its raw 0.2864. */}
						<ChartTooltip
							content={
								<ChartTooltipContent
									formatter={(value, _name, item) => {
										const entry =
											series.find((candidate) => candidate.key === item?.dataKey) ??
											series[series.length - 1]!
										return (
											<>
												<span
													aria-hidden
													className="size-2.5 shrink-0 self-center rounded-[2px]"
													style={{ backgroundColor: entry.color }}
												/>
												<div className="flex flex-1 items-center justify-between gap-3 leading-none">
													<span className="text-muted-foreground">
														{entry.descriptor.label}
													</span>
													<span className="font-mono font-medium tabular-nums text-foreground">
														{entry.descriptor.format(Number(value))}
													</span>
												</div>
											</>
										)
									}}
								/>
							}
						/>
						{painted.map((entry) => (
							<Area
								key={entry.key}
								type="monotone"
								dataKey={entry.key}
								stroke={entry.color}
								strokeWidth={1.5}
								fill={`url(#${gradientPrefix}-${entry.key})`}
								isAnimationActive={false}
								// A bucket one table has and the other doesn't is a gap, not a
								// zero — joining across it would draw a dip that never happened.
								connectNulls={false}
							/>
						))}
					</AreaChart>
				</ChartContainer>
			)}
		</ChartCard>
	)
}
