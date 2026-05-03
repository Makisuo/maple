import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { errorRateTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatErrorRate, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const VALUE_KEYS = ["errorRate"]

const baseChartConfig = {
	errorRate: { label: "Error Rate", color: "var(--chart-error)" },
} satisfies ChartConfig

export function ErrorRateAreaChart({
	data,
	className,
	legend,
	tooltip,
	referenceLines,
	syncId,
}: BaseChartProps) {
	const id = useId()
	const gradientId = `errorRateGradient-${id.replace(/:/g, "")}`
	const fadedGradientId = `errorRateGradientFaded-${id.replace(/:/g, "")}`
	const chartData = data ?? errorRateTimeSeriesData

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
			<AreaChart data={processedData} accessibilityLayer syncId={syncId} syncMethod="value">
				<defs>
					<VerticalGradient id={gradientId} color="var(--color-errorRate)" />
					{hasIncomplete && (
						<VerticalGradient
							id={fadedGradientId}
							color="var(--color-errorRate)"
							startOpacity={0.15}
							endOpacity={0}
						/>
					)}
				</defs>
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
					width={60}
					tickFormatter={(v) => formatErrorRate(v)}
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
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="text-muted-foreground">Error Rate</span>
											<span className="font-mono font-medium">
												{formatErrorRate(value as number)}
											</span>
										</span>
									)
								}}
							/>
						}
					/>
				)}
				{legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
				<Area
					type="linear"
					dataKey="errorRate"
					stroke="var(--color-errorRate)"
					fill={`url(#${gradientId})`}
					isAnimationActive={false}
				/>
				{hasIncomplete && (
					<Area
						type="linear"
						dataKey="errorRate_incomplete"
						stroke="var(--color-errorRate)"
						fill={`url(#${fadedGradientId})`}
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
			</AreaChart>
		</ChartContainer>
	)
}
