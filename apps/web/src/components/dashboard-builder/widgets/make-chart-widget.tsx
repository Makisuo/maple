import { memo, Suspense, type ReactNode } from "react"

import type { ChartLegendMode } from "@maple/ui/components/charts/_shared/chart-types"
import { getChartById, type ChartRegistryEntry } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { WidgetEmptyState, WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

// Every widget that mounts a `chartRegistry` component — line/bar/area (all
// persisted as `visualization: "chart"`), plus pie, histogram, heatmap and
// funnel — was its own near-identical file. They differed only in a default
// chart id, a default legend mode and which subset of `display` they forwarded,
// and that last difference was pure accident: a `thresholds` array set on a pie
// silently did nothing because `pie-widget.tsx` never passed it on.
//
// Collapsing them into one factory fixed the duplication but not the accident:
// the first version forwarded the WHOLE display config to a single
// `BaseChartProps` surface, so a setting a chart couldn't honour still vanished
// without a word — the erasure just moved from seven files into one.
//
// `renderChart` below is the fix. The registry is discriminated on `kind`, so
// each branch hands its chart only the settings that chart declares, and the
// compiler rejects the rest. This function is also the ONLY place that knows
// both shapes: `WidgetDisplayConfig` is a persisted, versioned schema and keeps
// its nested `pie` / `histogram` / `heatmap` / `funnel` bags, while the
// component props are flat. The unnesting belongs here and nowhere else.

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

interface RenderArgs {
	entry: ChartRegistryEntry
	display: WidgetDisplayConfig
	data: Record<string, unknown>[] | undefined
	className: string
	legend: ChartLegendMode | undefined
}

function renderChart({ entry, display, data, className, legend }: RenderArgs): ReactNode {
	const presentation = display.chartPresentation
	const tooltip = presentation?.tooltip
	// Opt-in, not inherited from legend visibility: the stats table costs up to
	// 45% of the widget's height, so a chart shows it only by asking for it.
	const seriesStats = presentation?.seriesStats ?? false
	const yAxis = display.yAxis

	// The axis block every cartesian chart reads. Spread rather than repeated so
	// a new axis setting reaches line, area and bar together — the three that
	// share a y scale — instead of reaching whichever branch was remembered.
	//
	// `fitYAxisToData` is NOT in here: bar cannot honour it (its value is the area
	// from the baseline, so lifting the floor lies about bar-to-bar ratios), and
	// while the shared block carried it the bar branch spread it in and the chart
	// dropped it in silence. It is passed per branch below, and the bar branch now
	// fails to compile if it is added back.
	const cartesian = {
		data,
		className,
		legend,
		tooltip,
		seriesStats,
		unit: display.unit,
		thresholds: display.thresholds,
		logScale: yAxis?.logScale,
		softMin: yAxis?.softMin,
		softMax: yAxis?.softMax,
	}

	switch (entry.kind) {
		case "line": {
			const Chart = entry.component
			return (
				<Chart
					{...cartesian}
					fitYAxisToData={yAxis?.fitYAxisToData}
					curveType={display.curveType}
					showPoints={presentation?.showPoints}
				/>
			)
		}
		case "area": {
			const Chart = entry.component
			return (
				<Chart
					{...cartesian}
					fitYAxisToData={yAxis?.fitYAxisToData}
					stacked={display.stacked}
					curveType={display.curveType}
					showPoints={presentation?.showPoints}
				/>
			)
		}
		case "bar": {
			const Chart = entry.component
			return <Chart {...cartesian} stacked={display.stacked} />
		}
		case "pie": {
			const Chart = entry.component
			return (
				<Chart
					data={data}
					className={className}
					legend={legend}
					tooltip={tooltip}
					unit={display.unit}
					donut={display.pie?.donut}
					innerRadius={display.pie?.innerRadius}
					showLabels={display.pie?.showLabels}
					showPercent={display.pie?.showPercent}
				/>
			)
		}
		case "histogram": {
			const Chart = entry.component
			return (
				<Chart
					data={data}
					className={className}
					tooltip={tooltip}
					unit={display.unit}
					logScale={yAxis?.logScale}
					bucketCount={display.histogram?.bucketCount}
					bucketWidth={display.histogram?.bucketWidth}
					logScaleY={display.histogram?.logScaleY}
				/>
			)
		}
		case "heatmap": {
			const Chart = entry.component
			return (
				<Chart
					data={data}
					className={className}
					tooltip={tooltip}
					unit={display.unit}
					colorScale={display.heatmap?.colorScale}
					scaleType={display.heatmap?.scaleType}
				/>
			)
		}
		case "funnel": {
			const Chart = entry.component
			return (
				<Chart
					data={data}
					className={className}
					unit={display.unit}
					showStepPercent={display.funnel?.showStepPercent}
				/>
			)
		}
		case "hbar": {
			const Chart = entry.component
			return <Chart data={data} className={className} unit={display.unit} />
		}
		// The fixed-metric service charts and the presentational gallery charts
		// take no query-builder settings — their series are decided at authoring
		// time. Reachable only through a hand-written or imported `chartId`, since
		// the Type picker never offers them; drawing them with their defaults is
		// the honest answer, and the compiler is what stops a settings rail from
		// quietly pretending they apply.
		case "service": {
			const Chart = entry.component
			return <Chart data={data} className={className} legend={legend} tooltip={tooltip} />
		}
		case "throughput": {
			const Chart = entry.component
			return <Chart data={data} className={className} legend={legend} tooltip={tooltip} />
		}
		default: {
			// Exhaustiveness: adding a registry kind without a branch fails here at
			// compile time rather than rendering nothing at runtime.
			const unhandled: never = entry
			return unhandled
		}
	}
}

export function makeChartWidget(options: ChartWidgetOptions) {
	const Widget = memo(function ChartWidget({ dataState, display, mode }: ChartWidgetProps) {
		const entry = getChartById(display.chartId ?? options.defaultChartId)
		if (!entry) return null

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
				{/* A ready state with nothing chartable — no rows, or not rows at all
				    (a scalar, an envelope) — is the empty state, decided here. The
				    chart components no longer fall back to sample data, so leaving
				    this to them would draw a blank plot with no explanation. */}
				{dataState.status === "ready" && (chartData === undefined || chartData.length === 0) ? (
					<WidgetEmptyState />
				) : (
					<Suspense fallback={skeleton}>
						{renderChart({
							entry,
							display,
							data: chartData,
							className: options.className ?? "h-full w-full aspect-auto",
							legend: display.chartPresentation?.legend ?? options.defaultLegend,
						})}
					</Suspense>
				)}
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

export const HbarWidget = makeChartWidget({
	displayName: "HbarWidget",
	// Every row is labelled in the chart itself, so a legend would repeat it.
	defaultChartId: "query-builder-hbar",
})
