import { memo, Suspense } from "react"

import type { ChartLegendMode } from "@maple/ui/components/charts/_shared/chart-types"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

// ---------------------------------------------------------------------------
// Every widget that mounts a `chartRegistry` component — line/bar/area (all
// persisted as `visualization: "chart"`), plus pie, histogram, heatmap and
// funnel — was its own near-identical file. They differed only in a default
// chart id, a default legend mode and which subset of `display` they forwarded,
// and that last difference was pure accident: a `thresholds` array set on a pie
// silently did nothing because `pie-widget.tsx` never passed it on.
//
// `BaseChartProps` is one interface covering every chart, and charts ignore the
// fields they don't read, so the factory forwards the whole display config. What
// a panel type can actually *set* is decided by its settings rail, not by which
// props its renderer happened to spell out.
// ---------------------------------------------------------------------------

interface ChartWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
}

interface ChartWidgetOptions {
	displayName: string
	/**
	 * Matches `toInitialState`, not the chart registry's own fallback, so a widget
	 * with no persisted chartId renders on the canvas as whatever the Type picker
	 * says it is.
	 */
	defaultChartId: string
	/**
	 * Legend mode when the widget has none persisted. A pie is unreadable without
	 * its category labels, so it defaults to a side legend; time-series charts
	 * default to hidden and the rest leave it to the chart component.
	 */
	defaultLegend?: ChartLegendMode
	/** Heatmaps fill their card; every other chart keeps its intrinsic aspect. */
	className?: string
}

export function makeChartWidget(options: ChartWidgetOptions) {
	const Widget = memo(function ChartWidget({ dataState, display, mode }: ChartWidgetProps) {
		const entry = getChartById(display.chartId ?? options.defaultChartId)
		if (!entry) return null

		const ChartComponent = entry.component
		const chartData =
			dataState.status === "ready" && Array.isArray(dataState.data) ? dataState.data : undefined
		const skeleton = <ChartSkeleton variant={entry.category} />

		return (
			<WidgetFrame
				title={display.title || "Untitled"}
				dataState={dataState}
				mode={mode}
				loadingSkeleton={skeleton}
			>
				<Suspense fallback={skeleton}>
					<ChartComponent
						data={chartData}
						className={options.className ?? "h-full w-full aspect-auto"}
						legend={display.chartPresentation?.legend ?? options.defaultLegend}
						// Opt-in, not inherited from legend visibility: the stats table
						// costs up to 45% of the widget's height, so a chart shows it
						// only by asking for it.
						seriesStats={display.chartPresentation?.seriesStats ?? false}
						tooltip={display.chartPresentation?.tooltip}
						showPoints={display.chartPresentation?.showPoints}
						stacked={display.stacked}
						curveType={display.curveType}
						thresholds={display.thresholds}
						unit={display.unit}
						logScale={display.yAxis?.logScale}
						softMin={display.yAxis?.softMin}
						softMax={display.yAxis?.softMax}
						fitYAxisToData={display.yAxis?.fitYAxisToData}
						pie={display.pie}
						histogram={display.histogram}
						heatmap={display.heatmap}
						funnel={display.funnel}
					/>
				</Suspense>
			</WidgetFrame>
		)
	})
	Widget.displayName = options.displayName
	return Widget
}

/**
 * The line/bar/area renderer. All three persist as `visualization: "chart"` and
 * differ only in `display.chartId`, so the canvas mounts one component for them.
 */
export const ChartWidget = makeChartWidget({
	displayName: "ChartWidget",
	defaultChartId: "query-builder-line",
	defaultLegend: "hidden",
})

export const PieWidget = makeChartWidget({
	displayName: "PieWidget",
	defaultChartId: "query-builder-pie",
	defaultLegend: "right",
})

export const HistogramWidget = makeChartWidget({
	displayName: "HistogramWidget",
	defaultChartId: "query-builder-histogram",
})

export const HeatmapWidget = makeChartWidget({
	displayName: "HeatmapWidget",
	defaultChartId: "query-builder-heatmap",
	className: "h-full w-full",
})

export const FunnelWidget = makeChartWidget({
	displayName: "FunnelWidget",
	defaultChartId: "query-builder-funnel",
})
