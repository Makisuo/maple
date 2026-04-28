import type React from "react"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

export interface ChartReferenceLine {
	x: string
	label?: string
	color?: string
	strokeDasharray?: string
}

export interface BaseChartProps {
	data?: Record<string, unknown>[]
	className?: string
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
	stacked?: boolean
	curveType?: "linear" | "monotone"
	referenceLines?: ChartReferenceLine[]
	unit?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	showPoints?: boolean
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
		bucketCount?: number
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
