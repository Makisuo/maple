import * as React from "react"
import { Area, AreaChart, XAxis, YAxis } from "recharts"
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/lib/utils"
import { formatBucketLabel } from "@/lib/format"

interface TimeseriesPoint {
	bucket: string
	count: number
}

interface IssueOccurrenceSparklineProps {
	data: ReadonlyArray<TimeseriesPoint>
	className?: string
}

const CHART_CONFIG: ChartConfig = {
	count: { label: "Occurrences", color: "var(--primary)" },
}

export function IssueOccurrenceSparkline({ data, className }: IssueOccurrenceSparklineProps) {
	const sorted = React.useMemo<Array<TimeseriesPoint>>(() => {
		return data
			.map((point) => ({ bucket: point.bucket, count: point.count }))
			.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket))
	}, [data])

	const axisContext = React.useMemo(() => {
		if (sorted.length < 2) {
			return { rangeMs: 0, bucketSeconds: undefined }
		}
		const firstMs = Date.parse(sorted[0]!.bucket)
		const secondMs = Date.parse(sorted[1]!.bucket)
		const lastMs = Date.parse(sorted[sorted.length - 1]!.bucket)
		const diffMs = secondMs - firstMs
		return {
			rangeMs: Number.isFinite(lastMs - firstMs) ? lastMs - firstMs : 0,
			bucketSeconds: diffMs > 0 && Number.isFinite(diffMs) ? diffMs / 1000 : undefined,
		}
	}, [sorted])

	const gradientId = React.useId().replace(/:/g, "")

	if (sorted.length === 0) {
		return (
			<div
				className={cn(
					"flex h-20 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground",
					className,
				)}
			>
				No activity in window
			</div>
		)
	}

	return (
		<ChartContainer config={CHART_CONFIG} className={cn("aspect-auto h-20 w-full", className)}>
			<AreaChart data={sorted} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
				<defs>
					<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
						<stop offset="100%" stopColor="var(--primary)" stopOpacity={0.03} />
					</linearGradient>
				</defs>
				<XAxis dataKey="bucket" hide />
				<YAxis hide domain={[0, "dataMax"]} />
				<ChartTooltip
					cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
					content={
						<ChartTooltipContent
							labelFormatter={(value) => formatBucketLabel(value, axisContext, "tooltip")}
							formatter={(value) => (
								<span className="flex items-center gap-2">
									<span
										className="size-2 shrink-0 rounded-[2px]"
										style={{ backgroundColor: "var(--primary)" }}
									/>
									<span className="text-muted-foreground">Occurrences</span>
									<span className="font-mono font-medium tabular-nums">
										{typeof value === "number" ? value.toLocaleString() : String(value)}
									</span>
								</span>
							)}
						/>
					}
				/>
				<Area
					type="monotone"
					dataKey="count"
					stroke="var(--primary)"
					strokeWidth={1.5}
					fill={`url(#${gradientId})`}
					isAnimationActive={false}
				/>
			</AreaChart>
		</ChartContainer>
	)
}
