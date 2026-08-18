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
	rateMode?: "per_second"
	logScale?: boolean
	softMin?: number
	softMax?: number
	/**
	 * Lower-bound the y-axis at the data's minimum (with padding) instead of
	 * pinning it to zero. Ignored when `softMin` or `logScale` are set.
	 */
	fitYAxisToData?: boolean
	/** Horizontal lines marking danger-zone values. */
	thresholds?: ChartThreshold[]
}

/**
 * The Recharts-era hover-sync and overlay escape hatches.
 *
 * Deliberately a separate mixin applied only to the charts that actually read
 * them, rather than a field on every chart's props. They are all scheduled for
 * removal: `syncId` and `overlay` are replaced by the plot cursor provider and
 * by children positioned from `usePlotRect()`, and `yAxisWidth` exists only
 * because those two need plot rects to line up across a grid. Keeping them
 * visible and narrow is what makes that removal a bounded change.
 */
export interface RechartsSyncProps {
	/**
	 * Synchronises hover across charts sharing the same id, through Recharts'
	 * own sync bus.
	 */
	syncId?: string
	/**
	 * Extra content rendered as a child INSIDE the Recharts chart, so it can use
	 * Recharts' hooks (`useXAxisScale`, `usePlotArea`, `ZIndexLayer`) — the commit
	 * deploy markers are the only consumer.
	 */
	overlay?: React.ReactNode
	/**
	 * Pins the y-axis to a fixed pixel width so plot areas line up across a
	 * synced grid. Omit to keep the chart's own content-sized width.
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

export interface QueryBuilderLineChartProps extends CartesianPlotProps {
	curveType?: "linear" | "monotone"
	showPoints?: boolean
}

export interface QueryBuilderAreaChartProps extends CartesianPlotProps, Pick<RechartsSyncProps, "syncId"> {
	stacked?: boolean
	curveType?: "linear" | "monotone"
	showPoints?: boolean
}

export interface QueryBuilderBarChartProps extends CartesianPlotProps, Pick<RechartsSyncProps, "syncId"> {
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
 * time — but they do live in the synced grids on `/` and the service detail
 * page, which is why they carry the sync mixin.
 */
export interface ServiceChartProps extends PlotChromeProps, RechartsSyncProps {}

export interface ThroughputAreaChartProps extends ServiceChartProps {
	rateMode?: "per_second"
}

/** The presentational gallery charts, which take data and nothing else. */
export interface SimpleChartProps extends PlotProps, Pick<RechartsSyncProps, "syncId"> {}

export type ChartCategory = "bar" | "hbar" | "area" | "line" | "pie" | "histogram" | "heatmap" | "funnel"
