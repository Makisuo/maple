import type React from "react"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

export interface BaseChartProps {
  data?: Record<string, unknown>[]
  className?: string
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
  rateMode?: "per_second"
  stacked?: boolean
  curveType?: "linear" | "monotone"
}

export type ChartCategory = "bar" | "area" | "line" | "radar"

export interface ChartRegistryEntry {
  id: string
  name: string
  description: string
  category: ChartCategory
  component: React.LazyExoticComponent<React.ComponentType<BaseChartProps>>
  sampleData: Record<string, unknown>[]
  tags: string[]
}
