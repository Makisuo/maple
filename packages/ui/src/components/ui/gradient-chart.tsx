"use client"

import { PlotSparkline } from "../plot/sparkline"

interface SparklineProps {
	data: { value: number }[]
	color?: string
	className?: string
}

/**
 * The services table's trend line.
 *
 * Kept as its own component rather than folded into `StatSparkline`: the two
 * take different inputs — this one is handed `{ value }` rows outright, while
 * the stat widget has to discover which column of an arbitrary timeseries row
 * holds the number — and they draw with different curves and gradient weights.
 * The drawing itself is shared.
 */
export function Sparkline({ data, color = "var(--chart-1)", className }: SparklineProps) {
	if (data.length === 0) {
		return <div className={className} />
	}

	return (
		<PlotSparkline
			values={data.map((point) => point.value)}
			color={color}
			fillOpacity={[0.5, 0.1]}
			className={className}
		/>
	)
}
