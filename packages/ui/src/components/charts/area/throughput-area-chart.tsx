import { useMemo, useId } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { throughputTimeSeriesData } from "../_shared/sample-data"
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
import {
	inferBucketSeconds,
	inferRangeMs,
	formatBucketLabel,
	bucketIntervalLabel,
	formatThroughput,
} from "../../../lib/format"

const VALUE_KEYS = ["throughput"]

export function ThroughputAreaChart({
	data,
	className,
	legend,
	tooltip,
	rateMode,
	referenceLines,
	syncId,
}: BaseChartProps) {
	const id = useId()
	const gradientId = `throughputGradient-${id.replace(/:/g, "")}`
	const fadedGradientId = `throughputGradientFaded-${id.replace(/:/g, "")}`
	const chartData = data ?? throughputTimeSeriesData
	const perSecond = rateMode === "per_second"

	const bucketSeconds = useMemo(
		() => inferBucketSeconds(chartData as Array<{ bucket: string }>),
		[chartData],
	)

	const rateLabel = useMemo(
		() => (perSecond ? "/s" : bucketIntervalLabel(bucketSeconds)),
		[perSecond, bucketSeconds],
	)

	const axisContext = useMemo(
		() => ({
			rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
			bucketSeconds,
		}),
		[chartData, bucketSeconds],
	)

	const hasSamplingData = useMemo(() => chartData.some((p) => p.hasSampling === true), [chartData])

	const hasErrorData = useMemo(
		() => chartData.some((p) => typeof p.errorRate === "number" && (p.errorRate as number) > 0),
		[chartData],
	)

	const {
		data: processedData,
		hasIncomplete,
		incompleteKeys,
	} = useIncompleteSegments(chartData, VALUE_KEYS)

	// Normalize throughput values to per-second rate and derive error throughput
	const displayData = useMemo(() => {
		return processedData.map((point) => {
			const errorRate = typeof point.errorRate === "number" ? Number(point.errorRate) : 0
			const shouldDivide = perSecond && !!bucketSeconds
			const divisor = shouldDivide ? bucketSeconds : 1

			const throughput = point.throughput != null ? Number(point.throughput) / divisor : null
			const throughputIncomplete =
				point.throughput_incomplete != null ? Number(point.throughput_incomplete) / divisor : null
			const tracedThroughput =
				point.tracedThroughput != null ? Number(point.tracedThroughput) / divisor : undefined

			return {
				...point,
				throughput: throughput ?? point.throughput,
				throughput_incomplete: throughputIncomplete ?? point.throughput_incomplete,
				tracedThroughput,
				errorThroughput: throughput != null ? (throughput * errorRate) / 100 : null,
				errorThroughput_incomplete:
					throughputIncomplete != null ? (throughputIncomplete * errorRate) / 100 : null,
			}
		})
	}, [processedData, perSecond, bucketSeconds])

	const chartConfig = useMemo(() => {
		const base: ChartConfig = {
			throughput: {
				label: rateLabel
					? `${hasSamplingData ? "~" : ""}Throughput (${rateLabel})`
					: `${hasSamplingData ? "~" : ""}Throughput`,
				color: "var(--chart-throughput)",
			},
		}
		if (hasErrorData) {
			base.errorThroughput = {
				label: rateLabel ? `Errors (${rateLabel})` : "Errors",
				color: "var(--chart-error)",
			}
			if (hasIncomplete) {
				base.errorThroughput_incomplete = {
					color: "var(--chart-error)",
				}
			}
		}
		if (hasSamplingData) {
			base.tracedThroughput = {
				label: rateLabel ? `Traced (${rateLabel})` : "Traced",
				color: "var(--chart-throughput)",
			}
		}
		return extendConfigWithIncomplete(base, incompleteKeys)
	}, [rateLabel, incompleteKeys, hasSamplingData, hasErrorData, hasIncomplete])

	return (
		<ChartContainer config={chartConfig} className={className}>
			<AreaChart data={displayData} accessibilityLayer syncId={syncId} syncMethod="value">
				<defs>
					<VerticalGradient id={gradientId} color="var(--color-throughput)" />
					{hasIncomplete && (
						<VerticalGradient
							id={fadedGradientId}
							color="var(--color-throughput)"
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
					width={rateLabel.length > 3 ? 90 : 60}
					tickFormatter={(value: number) => formatThroughput(value, rateLabel)}
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

									if (
										nameStr === "errorThroughput" ||
										nameStr === "errorThroughput_incomplete"
									) {
										if (value == null || Number(value) === 0) return null
										return (
											<span className="flex items-center gap-2">
												<span
													className="shrink-0 size-2.5 rounded-[2px] border border-dashed"
													style={{ borderColor: "var(--chart-error)" }}
												/>
												<span className="text-muted-foreground">Errors</span>
												<span className="font-mono font-medium">
													{Number(value).toLocaleString()}
													{rateLabel}
												</span>
											</span>
										)
									}

									if (nameStr === "tracedThroughput") {
										return (
											<span className="flex items-center gap-2">
												<span
													className="shrink-0 size-2.5 rounded-[2px] border border-dashed"
													style={{ borderColor: item.color }}
												/>
												<span className="text-muted-foreground">Traced</span>
												<span className="font-mono font-medium">
													{Number(value).toLocaleString()}
													{rateLabel}
												</span>
											</span>
										)
									}

									const isSampled = item.payload?.hasSampling === true
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="text-muted-foreground">
												{isSampled ? "Estimated" : "Throughput"}
											</span>
											<span className="font-mono font-medium">
												{isSampled ? "~" : ""}
												{Number(value).toLocaleString()}
												{rateLabel}
											</span>
										</span>
									)
								}}
							/>
						}
					/>
				)}
				{(legend === "visible" || hasErrorData) && <ChartLegend content={<ChartLegendContent />} />}
				<Area
					type="linear"
					dataKey="throughput"
					stroke="var(--color-throughput)"
					fill={`url(#${gradientId})`}
					isAnimationActive={false}
				/>
				{hasErrorData && (
					<Area
						type="linear"
						dataKey="errorThroughput"
						stroke="var(--color-errorThroughput)"
						fill="none"
						strokeWidth={1.5}
						strokeDasharray="3 3"
						dot={false}
						isAnimationActive={false}
					/>
				)}
				{hasSamplingData && (
					<Area
						type="linear"
						dataKey="tracedThroughput"
						stroke="var(--color-throughput)"
						fill="none"
						strokeWidth={1}
						strokeDasharray="4 4"
						strokeOpacity={0.5}
						dot={false}
						isAnimationActive={false}
						legendType="none"
					/>
				)}
				{hasIncomplete && (
					<Area
						type="linear"
						dataKey="throughput_incomplete"
						stroke="var(--color-throughput)"
						fill={`url(#${fadedGradientId})`}
						strokeWidth={2}
						strokeDasharray="4 4"
						dot={false}
						connectNulls
						legendType="none"
						isAnimationActive={false}
					/>
				)}
				{hasErrorData && hasIncomplete && (
					<Area
						type="linear"
						dataKey="errorThroughput_incomplete"
						stroke="var(--color-errorThroughput)"
						fill="none"
						strokeWidth={1.5}
						strokeDasharray="3 3"
						strokeOpacity={0.5}
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
