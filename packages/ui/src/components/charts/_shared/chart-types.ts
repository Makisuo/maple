import type React from "react"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

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
	/**
	 * Horizontal threshold lines drawn across the y-axis. Used to mark
	 * "danger zone" values on time-series charts.
	 */
	thresholds?: ChartThreshold[]
	unit?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	/**
	 * When true, the y-axis lower bound follows the minimum of the displayed
	 * data (with padding) instead of being pinned at zero. Ignored when
	 * `softMin` or `logScale` are set. Applies to line/area charts.
	 */
	fitYAxisToData?: boolean
	showPoints?: boolean
	/**
	 * Synchronizes hover state across charts that share the same id.
	 * Pass the same id to every chart in a dashboard / detail page so the
	 * tooltip cursor lines up to the same time bucket on hover.
	 */
	syncId?: string
	/**
	 * Extra content rendered as a child INSIDE the recharts chart (time-series
	 * charts only). Lets a host app inject an overlay that uses recharts' own
	 * hooks (`useXAxisScale`, `usePlotArea`, `ZIndexLayer`) — e.g. the commit
	 * deploy markers. The same element may be passed to several charts; each
	 * renders its own instance against its own chart context.
	 */
	overlay?: React.ReactNode
	/**
	 * Forces the y-axis (and thus the plot's left edge) to a fixed pixel width. Pass the
	 * SAME value to every chart in a synced grid so their plot areas line up exactly —
	 * the synced cursor then aligns across charts, and a shared `overlay` (commit deploy
	 * markers) groups identically on each instead of drifting with each chart's own
	 * y-axis width. Omit to keep the chart's own content-sized width.
	 */
	yAxisWidth?: number
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
	funnel?: {
		showStepPercent?: boolean
	}
}

export type ChartCategory = "bar" | "area" | "line" | "pie" | "histogram" | "heatmap" | "funnel"

export interface ChartRegistryEntry {
	id: string
	name: string
	description: string
	category: ChartCategory
	component: React.LazyExoticComponent<React.ComponentType<BaseChartProps>>
	sampleData: Record<string, unknown>[]
	tags: string[]
}
