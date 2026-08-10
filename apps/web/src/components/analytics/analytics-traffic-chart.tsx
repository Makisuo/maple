import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { formatNumber } from "@maple/ui/lib/format"

import type { WebAnalyticsPageviewsPoint, WebAnalyticsTimeseriesPoint } from "@/api/warehouse/web-analytics"
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, makeBucketLabeler } from "../infra/chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../infra/primitives/chart-card"

const CHART_CONFIG = {
	pageViews: { label: "Page views", color: "var(--chart-2)" },
	visitors: { label: "Visitors", color: "var(--chart-1)" },
} satisfies ChartConfig

interface AnalyticsTrafficChartProps {
	visitorPoints: ReadonlyArray<WebAnalyticsTimeseriesPoint>
	pageviewPoints: ReadonlyArray<WebAnalyticsPageviewsPoint>
	syncId?: string
}

/**
 * Page views and unique visitors on one set of axes.
 *
 * The two series come from different tables with different coverage — page views
 * from every session, visitors only from sessions whose SDK build posts the
 * analytics block — so they are deliberately *not* stacked and the visitors area
 * is drawn over the page-view area rather than under it. Reading visitors as a
 * subset of page views is the correct reading; reading their sum as anything is
 * not.
 *
 * Buckets are outer-joined on the union of both series' timestamps, so a window
 * where one table has data and the other doesn't shows a gap in one line instead
 * of shifting the other one sideways.
 */
export function AnalyticsTrafficChart({ visitorPoints, pageviewPoints, syncId }: AnalyticsTrafficChartProps) {
	const gradientPrefix = useId().replace(/:/g, "")

	const data = useMemo(() => {
		const byBucket = new Map<string, { visitors: number; pageViews: number }>()
		for (const point of pageviewPoints) {
			const entry = byBucket.get(point.bucket) ?? { visitors: 0, pageViews: 0 }
			entry.pageViews = point.pageViews
			byBucket.set(point.bucket, entry)
		}
		for (const point of visitorPoints) {
			const entry = byBucket.get(point.bucket) ?? { visitors: 0, pageViews: 0 }
			entry.visitors = point.visitors
			byBucket.set(point.bucket, entry)
		}
		const buckets = [...byBucket.keys()].sort()
		const label = makeBucketLabeler(buckets)
		return buckets.map((bucket) => ({ label: label(bucket), ...byBucket.get(bucket)! }))
	}, [visitorPoints, pageviewPoints])

	const totals = useMemo(
		() => ({
			pageViews: data.reduce((sum, row) => sum + row.pageViews, 0),
			visitors: visitorPoints.reduce((sum, row) => sum + row.visitors, 0),
		}),
		[data, visitorPoints],
	)

	// A flat-zero visitors series means no session in the window reports a visitor
	// id, not that nobody visited — the page-view series right next to it proves
	// otherwise. Drop the series rather than draw a line along the axis, and label
	// it so the absence reads as unreported instead of as zero.
	const hasVisitors = totals.visitors > 0
	const seriesKeys = hasVisitors ? (["pageViews", "visitors"] as const) : (["pageViews"] as const)

	const legend = (
		<>
			{(["pageViews", "visitors"] as const).map((key) => (
				<span key={key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span
						aria-hidden
						className="size-1.5 rounded-full"
						style={{
							backgroundColor:
								key === "visitors" && !hasVisitors
									? "var(--muted-foreground)"
									: CHART_CONFIG[key].color,
							opacity: key === "visitors" && !hasVisitors ? 0.4 : 1,
						}}
					/>
					{CHART_CONFIG[key].label}
					<span className="font-mono tabular-nums text-muted-foreground/70">
						{key === "visitors" && !hasVisitors ? "not reported" : formatNumber(totals[key])}
					</span>
				</span>
			))}
		</>
	)

	return (
		<ChartCard title="Traffic" legend={legend}>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<ChartContainer config={CHART_CONFIG} className="w-full" style={{ height: CHART_HEIGHT }}>
					<AreaChart data={data} syncId={syncId} syncMethod="value" margin={{ left: 4, right: 8 }}>
						<defs>
							{seriesKeys.map((key) => (
								<linearGradient
									key={key}
									id={`${gradientPrefix}-${key}`}
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop
										offset="0%"
										stopColor={CHART_CONFIG[key].color}
										stopOpacity={0.35}
									/>
									<stop
										offset="100%"
										stopColor={CHART_CONFIG[key].color}
										stopOpacity={0.02}
									/>
								</linearGradient>
							))}
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
							width={44}
							tickFormatter={(value: number) => formatNumber(value)}
							className="text-[10px]"
						/>
						<ChartTooltip content={<ChartTooltipContent />} />
						{/* Page views first so the smaller visitors area paints on top of it. */}
						{seriesKeys.map((key) => (
							<Area
								key={key}
								type="monotone"
								dataKey={key}
								stroke={CHART_CONFIG[key].color}
								strokeWidth={1.5}
								fill={`url(#${gradientPrefix}-${key})`}
								isAnimationActive={false}
							/>
						))}
					</AreaChart>
				</ChartContainer>
			)}
		</ChartCard>
	)
}
