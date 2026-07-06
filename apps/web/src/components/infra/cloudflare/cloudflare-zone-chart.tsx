import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/lib/utils"

import type { CloudflareZoneTimeseriesRow } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@/lib/format"
import { formatPercent } from "../format"
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, COLOR_PALETTE, transformRows } from "../chart-utils"
import { formatBytes } from "./format"

export type CloudflareZoneMetric = "requests" | "errorRate" | "cacheHitRate" | "bytes"

const METRIC_LABELS: Record<CloudflareZoneMetric, string> = {
	requests: "Edge requests",
	errorRate: "5xx error rate",
	cacheHitRate: "Cache hit rate",
	bytes: "Bandwidth",
}

const CHART_HEIGHT = 200

function formatMetricValue(value: number, metric: CloudflareZoneMetric): string {
	if (metric === "errorRate" || metric === "cacheHitRate") return formatPercent(value)
	if (metric === "bytes") return formatBytes(value)
	return formatNumber(value)
}

interface CloudflareZoneChartProps {
	buckets: ReadonlyArray<CloudflareZoneTimeseriesRow>
	metric: CloudflareZoneMetric
	waiting?: boolean
	syncId?: string
}

/**
 * One line per zone. Count metrics (`requests`/`bytes`) plot the per-zone
 * sums directly; ratio metrics derive the per-zone per-bucket ratio so zones
 * stay comparable regardless of traffic volume.
 */
export function CloudflareZoneChart({ buckets, metric, waiting, syncId }: CloudflareZoneChartProps) {
	const { data, series } = useMemo(() => {
		const longForm = buckets.map((row) => ({
			bucket: row.bucket,
			attributeValue: row.zoneName,
			value:
				metric === "errorRate"
					? row.requests > 0
						? row.errors5xx / row.requests
						: 0
					: metric === "cacheHitRate"
						? row.requests > 0
							? row.cacheHits / row.requests
							: 0
						: row[metric],
		}))
		return transformRows(longForm)
	}, [buckets, metric])

	// Zone names contain dots (`example.com`), which are invalid in a raw
	// `var(--color-…)` reference — colour series directly instead of via the
	// ChartContainer CSS variables.
	const seriesColor = useMemo(
		() =>
			new Map(series.map((name, idx) => [name, COLOR_PALETTE[idx % COLOR_PALETTE.length] ?? ""])),
		[series],
	)

	const config = useMemo<ChartConfig>(
		() =>
			Object.fromEntries(
				series.map((name) => [name, { label: name, color: seriesColor.get(name) }]),
			),
		[series, seriesColor],
	)

	return (
		<div className={cn("rounded-md border bg-card", waiting && "opacity-60 transition-opacity")}>
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
