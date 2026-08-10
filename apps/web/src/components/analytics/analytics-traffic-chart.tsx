import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"

import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, makeBucketLabeler } from "../infra/chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../infra/primitives/chart-card"
import type { AnalyticsMetricDescriptor, AnalyticsMetricSource } from "./metrics"

// The page's one accent, same as the KPI sparklines (`SPARK_COLOR.neutral`) and
// the row tints (`shareTint`). Deliberately not `--chart-1`, which is this same
// amber only in the dark theme and a blue in the light one — the chart would
// have disagreed with the tile that selected it, at half of all page loads.
const SERIES_COLOR = "var(--primary)"

interface AnalyticsTrafficChartProps {
	/** The metric selected in the KPI strip. Supplies the series and its formatting. */
	metric: AnalyticsMetricDescriptor
	source: AnalyticsMetricSource
	syncId?: string
}

/**
 * The selected metric over time.
 *
 * One series, not the fixed page-views-and-visitors pair this used to draw. The
 * pair was a compromise made when the rail above was inert; now that each tile
 * selects, showing two series would leave six metrics unreachable and would
 * force two incompatible units (a rate and a count) onto one axis. The strip is
 * the legend — the tile that is lit is the series that is drawn.
 *
 * Formatting for the axis and the tooltip comes from the descriptor, so bounce
 * rate renders as a percentage and average session as a duration without this
 * component knowing either metric exists.
 */
export function AnalyticsTrafficChart({ metric, source, syncId }: AnalyticsTrafficChartProps) {
	const gradientId = `${useId().replace(/:/g, "")}-area`

	const data = useMemo(() => {
		const points = metric.series(source)
		const label = makeBucketLabeler(points.map((point) => point.bucket))
		return points.map((point) => ({ label: label(point.bucket), value: point.value }))
	}, [metric, source])

	const config = useMemo(
		() =>
			({
				value: { label: metric.label, color: SERIES_COLOR },
			}) satisfies ChartConfig,
		[metric.label],
	)

	return (
		<ChartCard title={metric.label}>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					<AreaChart data={data} syncId={syncId} syncMethod="value" margin={{ left: 4, right: 8 }}>
						<defs>
							<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={0.35} />
								<stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={0.02} />
							</linearGradient>
						</defs>
						<CartesianGrid vertical={false} strokeDasharray={CHART_GRID_DASH} />
						<XAxis
							dataKey="label"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							minTickGap={24}
							className="text-[10px]"
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
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
									formatter={(value) => (
										<>
											<span
												aria-hidden
												className="size-2.5 shrink-0 self-center rounded-[2px]"
												style={{ backgroundColor: SERIES_COLOR }}
											/>
											<div className="flex flex-1 items-center justify-between gap-3 leading-none">
												<span className="text-muted-foreground">{metric.label}</span>
												<span className="font-mono font-medium tabular-nums text-foreground">
													{metric.format(Number(value))}
												</span>
											</div>
										</>
									)}
								/>
							}
						/>
						<Area
							type="monotone"
							dataKey="value"
							stroke={SERIES_COLOR}
							strokeWidth={1.5}
							fill={`url(#${gradientId})`}
							isAnimationActive={false}
						/>
					</AreaChart>
				</ChartContainer>
			)}
		</ChartCard>
	)
}
