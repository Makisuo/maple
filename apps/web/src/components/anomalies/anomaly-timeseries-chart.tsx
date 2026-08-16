import * as React from "react"
import { Area, AreaChart, ReferenceArea, ReferenceLine } from "recharts"
import type { AnomalyIncidentDocument, AnomalyIncidentTimeseriesResponse } from "@maple/domain/http"
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	ChartGrid,
	ChartXAxis,
	ChartYAxis,
} from "@maple/ui/components/ui/chart"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { formatSignalValue } from "./anomaly-format"

const SEVERITY_STROKE: Record<"critical" | "warning", string> = {
	critical: "var(--destructive)",
	warning: "var(--chart-4)",
} satisfies Record<"critical" | "warning", string>

export function AnomalyTimeseriesChart({
	incident,
	timeseries,
	className,
}: {
	incident: AnomalyIncidentDocument
	timeseries: AnomalyIncidentTimeseriesResponse
	className?: string
}) {
	const { signalType, baselineMedian, thresholdValue } = timeseries
	const stroke = SEVERITY_STROKE[incident.severity]

	const data = React.useMemo(
		() =>
			[...timeseries.buckets]
				.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket))
				.map((b) => ({ bucket: b.bucket, value: b.value })),
		[timeseries.buckets],
	)

	const axisContext = React.useMemo(() => {
		if (data.length < 2) return { rangeMs: 0, bucketSeconds: timeseries.bucketSeconds }
		const first = Date.parse(data[0]!.bucket)
		const last = Date.parse(data[data.length - 1]!.bucket)
		return { rangeMs: last - first, bucketSeconds: timeseries.bucketSeconds }
	}, [data, timeseries.bucketSeconds])

	// Snap the incident window to actual bucket values so the category axis
	// can place the shading.
	const window = React.useMemo(() => {
		if (data.length === 0) return null
		const startMs = Date.parse(incident.firstTriggeredAt)
		const endMs = incident.resolvedAt !== null ? Date.parse(incident.resolvedAt) : Infinity
		let x1: string | null = null
		let x2: string | null = null
		for (const point of data) {
			const t = Date.parse(point.bucket)
			if (t >= startMs && x1 === null) x1 = point.bucket
			if (t <= endMs) x2 = point.bucket
		}
		// Window starts after the last bucket (fresh incident): pin to the edge.
		if (x1 === null) x1 = data[data.length - 1]!.bucket
		if (x2 === null || Date.parse(x2) < Date.parse(x1)) x2 = x1
		return { x1, x2 }
	}, [data, incident.firstTriggeredAt, incident.resolvedAt])

	// Pad the y-domain so both reference lines stay visible.
	const yDomain = React.useMemo(() => {
		let maxVal = Math.max(thresholdValue, baselineMedian)
		for (const point of data) maxVal = Math.max(maxVal, point.value)
		return [0, maxVal * 1.15]
	}, [data, thresholdValue, baselineMedian])

	const chartConfig: ChartConfig = React.useMemo(
		() => ({ value: { label: "Observed", color: stroke } }),
		[stroke],
	)

	const valueFormatter = React.useCallback(
		(value: unknown) => {
			const parsed = typeof value === "number" ? value : Number(value)
			return formatSignalValue(signalType, Number.isFinite(parsed) ? parsed : 0)
		},
		[signalType],
	)

	if (data.length === 0) {
		return (
			<div
				className={cn(
					"flex h-64 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground",
					className,
				)}
			>
				No signal data in window
			</div>
		)
	}

	return (
		<div className={cn("space-y-2", className)}>
			<ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
				<AreaChart data={data} accessibilityLayer margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
					<defs>
						<linearGradient id="anomaly-observed-fill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor={stroke} stopOpacity={0.3} />
							<stop offset="95%" stopColor={stroke} stopOpacity={0.03} />
						</linearGradient>
					</defs>
					<ChartGrid />
					<ChartXAxis
						dataKey="bucket"
						tickFormatter={(value) => formatBucketLabel(value, axisContext, "tick")}
					/>
					<ChartYAxis
						tickMargin={8}
						width={70}
						tickFormatter={valueFormatter}
						domain={yDomain}
					/>
					{window ? (
						<ReferenceArea
							x1={window.x1}
							x2={window.x2}
							fill={stroke}
							fillOpacity={0.06}
							stroke="none"
						/>
					) : null}
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									const bucket = payload?.[0]?.payload?.bucket
									return bucket ? formatBucketLabel(bucket, axisContext, "tooltip") : ""
								}}
								formatter={(value) => (
									<span className="flex items-center gap-2">
										<span
											className="size-2.5 shrink-0 rounded-[2px]"
											style={{ backgroundColor: stroke }}
										/>
										<span className="text-muted-foreground">Observed</span>
										<span className="font-mono font-medium">{valueFormatter(value)}</span>
									</span>
								)}
							/>
						}
					/>
					<ReferenceLine
						y={baselineMedian}
						stroke="var(--muted-foreground)"
						strokeDasharray="4 4"
						strokeWidth={1}
						label={{
							value: "Baseline",
							position: "insideBottomRight",
							fill: "var(--muted-foreground)",
							fontSize: 11,
						}}
					/>
					<ReferenceLine
						y={thresholdValue}
						stroke="var(--destructive)"
						strokeDasharray="6 4"
						strokeWidth={1.5}
						label={{
							value: "Threshold",
							position: "insideTopRight",
							fill: "var(--destructive)",
							fontSize: 11,
						}}
					/>
					<Area
						type="monotone"
						dataKey="value"
						stroke={stroke}
						fill="url(#anomaly-observed-fill)"
						strokeWidth={2}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ChartContainer>
			<div className="flex items-center gap-4 text-[11px] text-muted-foreground">
				<span className="flex items-center gap-1.5">
					<span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: stroke }} />
					Observed
				</span>
				<span className="flex items-center gap-1.5">
					<span className="h-px w-4 border-t border-dashed border-muted-foreground" />
					Baseline median {formatSignalValue(signalType, baselineMedian)}
				</span>
				<span className="flex items-center gap-1.5">
					<span className="h-px w-4 border-t border-dashed border-destructive" />
					Threshold {formatSignalValue(signalType, thresholdValue)}
				</span>
			</div>
		</div>
	)
}
