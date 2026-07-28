import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { GaugeWidget } from "@/components/dashboard-builder/widgets/gauge-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { PieWidget } from "@/components/dashboard-builder/widgets/pie-widget"
import { HistogramWidget } from "@/components/dashboard-builder/widgets/histogram-widget"
import { HeatmapWidget } from "@/components/dashboard-builder/widgets/heatmap-widget"
import { FunnelWidget } from "@/components/dashboard-builder/widgets/funnel-widget"
import { MarkdownWidget } from "@/components/dashboard-builder/widgets/markdown-widget"

export type VisualizationComponent = React.ComponentType<{
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
}>

/**
 * `visualization` string → the component that draws it. Shared by the dashboard
 * canvas and the template preview so a new visualization only has to be
 * registered once.
 */
export const visualizationRegistry: Record<string, VisualizationComponent> = {
	chart: ChartWidget,
	stat: StatWidget,
	gauge: GaugeWidget,
	table: TableWidget,
	list: ListWidget,
	pie: PieWidget,
	histogram: HistogramWidget,
	heatmap: HeatmapWidget,
	funnel: FunnelWidget,
	markdown: MarkdownWidget,
}

/** Unknown visualizations fall back to a chart, as the canvas has always done. */
export const visualizationFor = (visualization: string): VisualizationComponent =>
	visualizationRegistry[visualization] ?? visualizationRegistry.chart!
