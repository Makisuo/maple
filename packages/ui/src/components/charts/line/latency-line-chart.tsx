import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { latencyTimeSeriesData } from "../_shared/sample-data"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatLatency, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const VALUE_KEYS = ["p99LatencyMs", "p95LatencyMs", "p50LatencyMs"]

const baseChartConfig = {
	p99LatencyMs: { label: "P99", color: "var(--chart-p99)" },
	p95LatencyMs: { label: "P95", color: "var(--chart-p95)" },
	p50LatencyMs: { label: "P50", color: "var(--chart-p50)" },
} satisfies ChartConfig

export function LatencyLineChart({ data, className, legend, tooltip, referenceLines }: BaseChartProps) {
	const chartData = data ?? latencyTimeSeriesData

	const {
		data: processedData,
		hasIncomplete,
		incompleteKeys,
	} = useIncompleteSegments(chartData, VALUE_KEYS)

	const chartConfig = useMemo(
		() => extendConfigWithIncomplete(baseChartConfig, incompleteKeys),
		[incompleteKeys],
	)

	const axisContext = useMemo(
		() => ({
			rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
			bucketSeconds: inferBucketSeconds(chartData as Array<{ bucket: string }>),
		}),
		[chartData],
	)

	return (
		<ChartContainer config={chartConfig} className={className}>
			<LineChart data={processedData} accessibilityLayer>
				<CartesianGrid vertical={false} />
				{referenceLines?.map((rl, i) => (
					<ReferenceLine
						key={`release-${i}`}
						x={rl.x}
						stroke={rl.color ?? "var(--muted-foreground)"}
						strokeDasharray={rl.strokeDasharray ?? "6 4"}
						strokeWidth={1}
					/>
				))}
				<XAxis
					dataKey="bucket"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					tickFormatter={(v) => formatBucketLabel(v, axisContext, "tick")}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					tickFormatter={(v) => formatLatency(v)}
				/>
				{tooltip !== "hidden" && (
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									if (!payload?.[0]?.payload?.bucket) return ""
									const bucket = payload[0].payload.bucket as string
									const release = referenceLines?.find((rl) => rl.x === bucket)
									return (
										<span>
											{formatBucketLabel(bucket, axisContext, "tooltip")}
											{release?.label && (
												<span className="ml-2 text-muted-foreground">
													Deploy: {release.label}
												</span>
											)}
										</span>
									)
								}}
								formatter={(value, name, item) => {
									const nameStr = String(name)
									const isIncomplete = nameStr.endsWith("_incomplete")
									const baseKey = isIncomplete
										? nameStr.replace(/_incomplete$/, "")
										: nameStr
									if (isIncomplete && item.payload?.[baseKey] != null) return null
									if (!isIncomplete && value == null) return null
									const config = baseChartConfig[baseKey as keyof typeof baseChartConfig]
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: config?.color ?? item.color }}
											/>
											<span className="text-muted-foreground">
												{config?.label ?? baseKey}
											</span>
											<span className="font-mono font-medium">
												{formatLatency(value as number)}
											</span>
										</span>
									)
								}}
							/>
						}
					/>
				)}
				{legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
				<Line
					type="linear"
					dataKey="p99LatencyMs"
					stroke="var(--color-p99LatencyMs)"
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
				<Line
					type="linear"
					dataKey="p95LatencyMs"
					stroke="var(--color-p95LatencyMs)"
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
				<Line
					type="linear"
					dataKey="p50LatencyMs"
					stroke="var(--color-p50LatencyMs)"
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
				{hasIncomplete && (
					<Line
						type="linear"
						dataKey="p99LatencyMs_incomplete"
						stroke="var(--color-p99LatencyMs)"
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
				{hasIncomplete && (
					<Line
						type="linear"
						dataKey="p95LatencyMs_incomplete"
						stroke="var(--color-p95LatencyMs)"
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
				{hasIncomplete && (
					<Line
						type="linear"
						dataKey="p50LatencyMs_incomplete"
						stroke="var(--color-p50LatencyMs)"
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
			</LineChart>
		</ChartContainer>
	)
}
