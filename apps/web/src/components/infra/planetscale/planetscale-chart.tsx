import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleInfraTimeseriesRow } from "@/api/warehouse/planetscale-infra"
import { formatNumber } from "@/lib/format"
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, makeBucketLabeler } from "../chart-utils"
import { formatPercent } from "../format"

export type PlanetScaleMetric = "connectionsAvg" | "cpuMaxPercent" | "memMaxPercent" | "replicaLagMaxSeconds"

const METRIC_LABELS: Record<PlanetScaleMetric, string> = {
	connectionsAvg: "Active connections",
	cpuMaxPercent: "CPU utilization (max)",
	memMaxPercent: "Memory utilization (max)",
	replicaLagMaxSeconds: "Replica lag (max)",
}

const METRIC_COLORS: Record<PlanetScaleMetric, string> = {
	connectionsAvg: "var(--chart-1)",
	cpuMaxPercent: "var(--chart-2)",
	memMaxPercent: "var(--chart-3)",
	replicaLagMaxSeconds: "var(--chart-4)",
}

const CHART_HEIGHT = 200

function formatMetricValue(value: number, metric: PlanetScaleMetric): string {
	if (metric === "cpuMaxPercent" || metric === "memMaxPercent") return formatPercent(value / 100)
	if (metric === "replicaLagMaxSeconds") {
		return value >= 1 ? `${value.toFixed(1)}s` : `${Math.round(value * 1000)}ms`
	}
	return formatNumber(value)
}

/** One single-series health chart for the /infra/planetscale database detail page. */
export function PlanetScaleChart({
	buckets,
	metric,
	waiting,
	syncId,
}: {
	buckets: ReadonlyArray<PlanetScaleInfraTimeseriesRow>
	metric: PlanetScaleMetric
	waiting?: boolean
	syncId?: string
}) {
	const data = useMemo(() => {
		const labeler = makeBucketLabeler(buckets.map((row) => row.bucket))
		return buckets.map((row) => ({ time: labeler(row.bucket), value: row[metric] }))
	}, [buckets, metric])

	const config = useMemo<ChartConfig>(
		() => ({ value: { label: METRIC_LABELS[metric], color: METRIC_COLORS[metric] } }),
		[metric],
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
					<LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }} syncId={syncId}>
						<CartesianGrid strokeDasharray={CHART_GRID_DASH} stroke="var(--border)" vertical={false} />
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
							isAnimationActive={false}
						/>
					</LineChart>
				</ChartContainer>
			)}
		</div>
	)
}
