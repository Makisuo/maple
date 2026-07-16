import * as React from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { MetricTypeBadge } from "./metric-type-badge"
import type { MetricSparklinePoint } from "@/api/warehouse/metrics"

export interface MetricPreviewEntry {
	metricName: string
	metricType: string
	metricUnit: string
	metricDescription: string
	serviceNames: string[]
}

/**
 * Cheap type-aware preview: gauges/histograms plot the average value; counters
 * plot datapoints per interval (true rate needs the window-function CTE, which
 * must not run one-per-card — the detail page shows real rate).
 */
function sparklineRows(
	metricType: string,
	points: ReadonlyArray<MetricSparklinePoint>,
): Array<{ bucket: string; v: number }> {
	return points.map((point) => ({
		bucket: point.bucket,
		v: metricType === "sum" ? point.dataPointCount : point.avgValue,
	}))
}

const TYPE_COLORS: Record<string, string> = {
	sum: "var(--chart-p50)",
	gauge: "var(--severity-info)",
	histogram: "var(--chart-4)",
	exponential_histogram: "var(--primary)",
}

interface MetricPreviewCardProps {
	entry: MetricPreviewEntry
	points: ReadonlyArray<MetricSparklinePoint> | undefined
	loading: boolean
	onOpen: () => void
}

export function MetricPreviewCard({ entry, points, loading, onOpen }: MetricPreviewCardProps) {
	const rows = React.useMemo(
		() => sparklineRows(entry.metricType, points ?? []),
		[entry.metricType, points],
	)

	return (
		<button
			type="button"
			onClick={onOpen}
			className="group flex flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
		>
			<div className="flex w-full items-start justify-between gap-2">
				<span className="min-w-0 truncate font-mono text-xs font-medium" title={entry.metricName}>
					{entry.metricName}
				</span>
				<MetricTypeBadge type={entry.metricType} />
			</div>

			<div className="h-12 w-full">
				{rows.length >= 2 ? (
					<StatSparkline
						data={rows}
						color={TYPE_COLORS[entry.metricType] ?? "var(--chart-1)"}
						className="h-full w-full"
					/>
				) : (
					<div className="flex h-full items-center text-[10px] text-muted-foreground">
						{loading ? "Loading…" : "Not enough datapoints for a preview"}
					</div>
				)}
			</div>

			<div className="flex w-full items-center justify-between gap-2 text-[10px] text-muted-foreground">
				<span className="truncate">
					{entry.serviceNames.length === 1
						? entry.serviceNames[0]
						: `${entry.serviceNames.length} services`}
				</span>
				<span className="flex shrink-0 items-center gap-1.5">
					{entry.metricUnit && (
						<Badge variant="outline" className="px-1 py-0 font-mono text-[9px]">
							{entry.metricUnit}
						</Badge>
					)}
					{entry.metricType === "sum" ? "datapoints/interval" : "avg"}
				</span>
			</div>
		</button>
	)
}
