import { useMemo, type ReactNode } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleInfraTimeseriesRow } from "@/api/warehouse/planetscale-infra"
import { formatNumber } from "@maple/ui/lib/format"
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, makeBucketLabeler } from "../chart-utils"
import {
	renderChartEventMarkers,
	snapMarkersToBuckets,
	type ChartEventMarker,
} from "../primitives/chart-event-markers"
import { formatPercent } from "@maple/ui/lib/format"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../primitives/chart-card"
import { formatLag, formatStoragePercent } from "./metrics"

export type PlanetScaleMetric =
	| "connectionsAvg"
	| "cpuMaxPercent"
	| "memMaxPercent"
	| "storageUsedPercent"
	| "replicaLagMaxSeconds"

const METRIC_LABELS: Record<PlanetScaleMetric, string> = {
	connectionsAvg: "Active connections",
	cpuMaxPercent: "CPU utilization (max)",
	memMaxPercent: "Memory utilization (max)",
	storageUsedPercent: "Storage used (max)",
	replicaLagMaxSeconds: "Replica lag (max)",
} satisfies Record<PlanetScaleMetric, string>

const METRIC_COLORS: Record<PlanetScaleMetric, string> = {
	connectionsAvg: "var(--chart-1)",
	cpuMaxPercent: "var(--chart-2)",
	memMaxPercent: "var(--chart-3)",
	storageUsedPercent: "var(--chart-5)",
	replicaLagMaxSeconds: "var(--chart-4)",
} satisfies Record<PlanetScaleMetric, string>

function formatMetricValue(value: number, metric: PlanetScaleMetric): string {
	if (metric === "cpuMaxPercent" || metric === "memMaxPercent") return formatPercent(value / 100)
	if (metric === "storageUsedPercent") return formatStoragePercent(value)
	if (metric === "replicaLagMaxSeconds") return formatLag(value)
	return formatNumber(value)
}

/** Percentages plot against a fixed 0–100 so a flat 94% disk still looks like 94%. */
const isPercentMetric = (metric: PlanetScaleMetric) =>
	metric === "cpuMaxPercent" || metric === "memMaxPercent" || metric === "storageUsedPercent"

export function PlanetScaleChartLoading({ metric }: { metric: PlanetScaleMetric }) {
	return (
		<ChartCard title={METRIC_LABELS[metric]} legend={null}>
			<div className="px-3 pb-3 pt-2" style={{ height: CHART_HEIGHT }}>
				<Skeleton className="h-full w-full" />
			</div>
		</ChartCard>
	)
}

/** One single-series health chart for the /infra/planetscale database detail page. */
export function PlanetScaleChart({
	buckets,
	metric,
	waiting,
	syncId,
	scope,
	markers,
	emptyMessage,
	className,
}: {
	buckets: ReadonlyArray<PlanetScaleInfraTimeseriesRow>
	metric: PlanetScaleMetric
	waiting?: boolean
	syncId?: string
	scope?: ReactNode
	/** Deploys and branch events drawn onto the plot — what explains a cliff. */
	markers?: ReadonlyArray<ChartEventMarker>
	/** Overridden when the emptiness has a cause worth naming (metrics paused, say). */
	emptyMessage?: ReactNode
	className?: string
}) {
	const data = useMemo(() => {
		const labeler = makeBucketLabeler(buckets.map((row) => row.bucket))
		return buckets.map((row) => ({ time: labeler(row.bucket), value: row[metric] }))
	}, [buckets, metric])

	// The x-axis is categorical (bucket labels), so markers snap by index and
	// read their label back — see chart-event-markers.
	const snapped = useMemo(() => {
		if (markers === undefined || markers.length === 0) return []
		const isos = buckets.map((row) => row.bucket)
		const labeler = makeBucketLabeler(isos)
		return snapMarkersToBuckets(markers, isos, labeler)
	}, [markers, buckets])

	// Storage can be null for buckets the volume gauges never reported. Those are
	// gaps in the line, not zeroes — but a series of only gaps is an empty chart.
	const hasValues = useMemo(() => data.some((point) => point.value !== null), [data])

	const config = useMemo<ChartConfig>(
		() => ({ value: { label: METRIC_LABELS[metric], color: METRIC_COLORS[metric] } }),
		[metric],
	)

	return (
		<ChartCard
			title={METRIC_LABELS[metric]}
			legend={null}
			scope={scope}
			className={cn("transition-opacity", waiting && "opacity-60", className)}
		>
			{!hasValues ? (
				<ChartCardMessage>{emptyMessage ?? CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					<LineChart
						data={data}
						margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
						syncId={syncId}
					>
						<CartesianGrid
							strokeDasharray={CHART_GRID_DASH}
							stroke="var(--border)"
							vertical={false}
						/>
						{renderChartEventMarkers(snapped)}
						<XAxis
							dataKey="time"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							fontSize={10}
							stroke="var(--muted-foreground)"
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							fontSize={10}
							width={52}
							stroke="var(--muted-foreground)"
							domain={isPercentMetric(metric) ? [0, 100] : undefined}
							tickFormatter={(v: number) => formatMetricValue(v, metric)}
						/>
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
							content={
								<ChartTooltipContent
									indicator="dot"
									formatter={(value) => (
										<div className="flex flex-1 items-center justify-between gap-3 leading-none">
											<span className="text-muted-foreground">
												{METRIC_LABELS[metric]}
											</span>
											<span className="font-mono font-medium tabular-nums text-foreground">
												{formatMetricValue(Number(value), metric)}
											</span>
										</div>
									)}
								/>
							}
						/>
						<Line
							type="monotone"
							dataKey="value"
							stroke={METRIC_COLORS[metric]}
							strokeWidth={1.5}
							dot={false}
							// A bucket with no sample is a hole in the data; bridging it would
							// draw a disk trend that never happened.
							connectNulls={false}
							isAnimationActive={false}
						/>
					</LineChart>
				</ChartContainer>
			)}
		</ChartCard>
	)
}
