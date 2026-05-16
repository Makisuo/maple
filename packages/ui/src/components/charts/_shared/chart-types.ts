import type React from "react"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

export interface ChartReferenceLine {
	x: string
	label?: string
	color?: string
	strokeDasharray?: string
}

export interface ChartThreshold {
	value: number
	color: string
	label?: string
}

export interface BaseChartProps {
	data?: Record<string, unknown>[]
	className?: string
	legend?: ChartLegendMode
	/** When true, the legend block includes the per-series Min/Max/Mean/Last table. */
	seriesStats?: boolean
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
	stacked?: boolean
	curveType?: "linear" | "monotone"
	referenceLines?: ChartReferenceLine[]
	/**
	 * Horizontal threshold lines drawn across the y-axis. Used to mark
	 * "danger zone" values on time-series charts.
	 */
	thresholds?: ChartThreshold[]
	unit?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	showPoints?: boolean
	/**
	 * Synchronizes hover state across charts that share the same id.
	 * Pass the same id to every chart in a dashboard / detail page so the
	 * tooltip cursor lines up to the same time bucket on hover.
	 */
	syncId?: string
	pie?: {
		donut?: boolean
		innerRadius?: number
		showLabels?: boolean
		showPercent?: boolean
	}
	histogram?: {
		bucketCount?: number
		bucketWidth?: number
		logScaleY?: boolean
	}
	heatmap?: {
		colorScale?: "viridis" | "magma" | "cividis" | "blues" | "reds"
		scaleType?: "linear" | "log"
	}
}

export type ChartCategory = "bar" | "area" | "line" | "pie" | "histogram" | "heatmap"

export interface ChartRegistryEntry {
	id: string
	name: string
	description: string
	category: ChartCategory
	component: React.LazyExoticComponent<React.ComponentType<BaseChartProps>>
	sampleData: Record<string, unknown>[]
	tags: string[]
}
