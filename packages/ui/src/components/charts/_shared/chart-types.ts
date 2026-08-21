import type React from "react"
import type { HeatmapColorScale, HeatmapScaleType } from "@maple/domain/http"

export type ChartLegendMode = "visible" | "hidden" | "right"
export type ChartTooltipMode = "visible" | "hidden"

export interface ChartThreshold {
	value: number
	color: string
	label?: string
}

/**
 * The props every chart takes, and the only ones a generic caller (the gallery
 * thumbnails, the chart picker) may rely on.
 *
 * This replaced a single `BaseChartProps` that carried all twenty-odd knobs for
 * all fifteen charts. Every chart received every prop and silently dropped the
 * ones it didn't destructure, so a `thresholds` array set on a pie did nothing
 * and nothing said so — not the types, not the settings rail, not a runtime
 * warning. The tiers below exist so that a setting a chart cannot honour fails
 * to compile at the call site instead of vanishing.
 */
export interface PlotProps {
	data?: Record<string, unknown>[]
	className?: string
}

/** Charts that draw a legend and a tooltip — everything except the self-labelling ones. */
export interface PlotChromeProps extends PlotProps {
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
}

/**
 * Axis controls shared by the cartesian time-series charts (line, area, bar).
 *
 * `unit` also reaches the categorical charts, which format values with it but
 * have no axis to scale — it is declared on each of those separately rather
 * than hoisted here, so this stays "what an x/y plot needs".
 */
export interface CartesianPlotProps extends PlotChromeProps {
	/** Adds the per-series Min/Max/Mean/Last table to the legend block. */
	seriesStats?: boolean
	unit?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	/** Horizontal lines marking danger-zone values. */
	thresholds?: ChartThreshold[]
}

/**
 * Lower-bound the y-axis at the data's minimum (with padding) instead of
 * pinning it to zero. Ignored when `softMin` or `logScale` are set.
 *
 * This sits BELOW `CartesianPlotProps` because bar is cartesian and cannot
 * honour it: a bar encodes its value as the area between the baseline and its
 * top, so lifting the floor makes the ratio between two bars a lie. While it
 * lived on the shared tier the bar branch of the widget factory spread it in
 * and the chart silently dropped it, so a bar widget carrying
 * `yAxis.fitYAxisToData` — reachable from the v2 API, MCP `add_dashboard_widget`
 * or an imported dashboard — kept a zero-anchored axis while the line beside it,
 * same config, zoomed. Declared as a mixin, passing it to bar fails to compile.
 */
export interface FitYAxisPlotProps {
	fitYAxisToData?: boolean
}

/**
 * The annotation slot, for charts that can host one.
 *
 * A separate mixin applied only to the charts that actually read it, rather than
 * a field on every chart's props.
 *
 * This is what is left of the old `RechartsSyncProps`. `syncId` is gone: it drove
 * Recharts' hover-sync event bus, which re-rendered every synced chart's tooltip
 * store on each pointer tick, and the linked cursor in `useLinkedCursor`
 * replaced it — CSS variables on a container, no React state at all. The prop
 * had been dead in production since that became the default.
 */
export interface PlotOverlayProps {
	/**
	 * A DOM layer stacked over the plot — the commit deploy markers.
	 *
	 * Routed into `PlotFrame`'s `overlay` slot, where it reads the plot geometry
	 * from `usePlotRect()` / `usePlotScales()`. Under Recharts it had to be a
	 * CHILD of the chart to reach `useXAxisScale` and `ZIndexLayer`.
	 */
	overlay?: React.ReactNode
	/**
	 * Pins the plot's left edge, in pixels, so plot areas line up across a grid.
	 * Omit to let each chart size its own y-axis gutter.
	 *
	 * This survived the port because the charts do NOT line up on their own —
	 * measured across the service grid, the four plots start between 38px and
	 * 65px from the card's edge, because each solves its margin from its own tick
	 * labels ("155.0ms" against "0.9"). The linked cursor does not care (it works
	 * in per-plot ratios), but the commit markers do: whether two deploys merge
	 * into one label chip is decided by `layoutMarkerLabels` against the plot
	 * width, so a 26px spread can group the same commits differently on adjacent
	 * cards.
	 *
	 * Recharts implemented this as `<YAxis width>`. Here it is a LEFT MARGIN LOCK
	 * (`ChartSpecBase.margin`) — `resolveMarginLocks` pins the side you name and
	 * leaves the rest to the automatic solver. Pick a value above every chart's
	 * natural gutter, since a lock below it clips the tick labels rather than
	 * growing.
	 */
	yAxisWidth?: number
}

/* ---------------------------------------------------------------------------
 * Per-chart props.
 *
 * The four per-type option bags (`pie`, `histogram`, `heatmap`, `funnel`) that
 * used to hang off the shared interface are FLATTENED here. The persisted
 * `WidgetDisplayConfig` keeps its nested, versioned shape — the widget factory's
 * per-kind switch is where the two meet, which is the one place that should know
 * both.
 * ------------------------------------------------------------------------- */

export interface QueryBuilderLineChartProps extends CartesianPlotProps, FitYAxisPlotProps {
	curveType?: "linear" | "monotone"
	showPoints?: boolean
}

export interface QueryBuilderAreaChartProps extends CartesianPlotProps, FitYAxisPlotProps {
	stacked?: boolean
	curveType?: "linear" | "monotone"
	showPoints?: boolean
}

export interface QueryBuilderBarChartProps extends CartesianPlotProps {
	stacked?: boolean
}

export interface QueryBuilderPieChartProps extends PlotChromeProps {
	unit?: string
	donut?: boolean
	innerRadius?: number
	showLabels?: boolean
	showPercent?: boolean
}

export interface QueryBuilderHistogramChartProps extends PlotProps {
	tooltip?: ChartTooltipMode
	unit?: string
	/**
	 * The generic y-axis log setting, which on a histogram means the COUNT axis —
	 * a histogram's bins are its x axis and are never log-scaled. Overridden by
	 * `logScaleY` when that is set.
	 */
	logScale?: boolean
	bucketCount?: number
	bucketWidth?: number
	/**
	 * The histogram-specific override for the same count axis, so a dashboard can
	 * log-scale counts here without log-scaling every other chart sharing the
	 * widget's y-axis config. Resolves as `logScaleY ?? logScale ?? false`.
	 */
	logScaleY?: boolean
}

export interface QueryBuilderHeatmapChartProps extends PlotProps {
	tooltip?: ChartTooltipMode
	unit?: string
	colorScale?: HeatmapColorScale
	scaleType?: HeatmapScaleType
}

export interface QueryBuilderFunnelChartProps extends PlotProps {
	unit?: string
	/**
	 * Percentage labels on each stage. Unset shows the share of the first stage;
	 * `true` adds the step-to-step conversion; `false` suppresses both.
	 */
	showStepPercent?: boolean
}

export interface QueryBuilderHbarChartProps extends PlotProps {
	unit?: string
}

/**
 * The fixed-metric service charts (latency, throughput, apdex, error rate).
 *
 * They read no query-builder settings — their series are known at authoring
 * time — but they do live in the linked-cursor grids on `/` and the service
 * detail page, and the service page draws commit markers over them, which is
 * why they carry the overlay slot.
 */
export interface ServiceChartProps extends PlotChromeProps, PlotOverlayProps {}

export interface ThroughputAreaChartProps extends ServiceChartProps {
	rateMode?: "per_second"
}

/** The presentational gallery charts, which take data and nothing else. */
export interface SimpleChartProps extends PlotProps {}

export type ChartCategory = "bar" | "hbar" | "area" | "line" | "pie" | "histogram" | "heatmap" | "funnel"
