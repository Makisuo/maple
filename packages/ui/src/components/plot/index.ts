/**
 * The plot layer's public surface.
 *
 * Charts compose from many of these at once — the line chart alone reached into
 * seven modules — so the barrel is the import site, and the file layout stays an
 * implementation detail free to move.
 *
 * Re-exporting this much is only safe because `@maple/ui` declares
 * `"sideEffects": ["**\/*.css"]`. Without it a bundler must assume every module
 * behind a barrel does observable work at import time and keeps all of them,
 * which would have pulled the whole timeseries stack into any chunk that wanted
 * one hook — undoing the per-chart `lazy()` split in `charts/registry.ts`.
 */

// The frame: the chart host, its published geometry, and the header legend slot.
export {
	PlotFrame,
	PlotLegendSlotContext,
	UNBOUNDED_FOCUS_DISTANCE,
	plotScalesInterchangeable,
	usePlotLegendSlot,
	usePlotRect,
	usePlotScales,
	type PlotFrameProps,
	type PlotLegendItem,
	type PlotLegendSlot,
	type PlotRect,
	type PlotRectStore,
	type PlotRenderer,
	type PlotScales,
	type PlotScalesStore,
} from "./plot-frame"

// Time series: the shared model, the axis builders, and the compound parts.
export {
	HARD_SERIES_LIMIT,
	SERIES_FALLBACK_COLOR,
	Timeseries,
	asFiniteNumber,
	bucketBandDomain,
	hoistsLegend,
	legendPlacementFor,
	normaliseTimeseriesRows,
	scaleTimeseriesRates,
	timeseriesBandXAxis,
	timeseriesTooltipSeries,
	timeseriesXAxis,
	timeseriesYAxis,
	useTimeseriesModel,
	type NormalisedTimeseries,
	type TimeseriesAxisContext,
	type TimeseriesFrameProps,
	type TimeseriesLegendProps,
	type TimeseriesModel,
	type TimeseriesModelOptions,
	type TimeseriesRow,
	type TimeseriesSeries,
	type TimeseriesSeriesDefinition,
	type TimeseriesTooltipProps,
	type TimeseriesYAxisOptions,
} from "./timeseries"

// Fixed-metric charts: latency, throughput, apdex, error rate.
export {
	FixedMetricLegend,
	fixedMetricTooltipBody,
	normaliseFixedRows,
	useFixedMetricModel,
	type FixedMetricModel,
	type FixedMetricSeries,
} from "./fixed-metrics"

// Tooltips: the definition-side config, the focus store, and the card body.
export {
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	maybeTooltip,
	resolveTooltipHighlight,
	useTooltipFocus,
	type PlotTooltipSeries,
	type TooltipFocus,
	type TooltipFocusStore,
} from "./plot-tooltip"

// The DOM tooltip an overlay opens, and the suppression flag it raises.
export {
	ChartFloatingTooltip,
	ChartTooltipSuppressionProvider,
	chartTooltipCardClassName,
	useChartTooltipSuppressed,
	useSuppressChartTooltip,
} from "./floating-tooltip"

// The compound legend: provider, parts, and the highlight state a chart owns.
export {
	MUTED_COLOR_AMOUNT,
	MUTED_OPACITY,
	PlotLegend,
	PlotSeriesLegend,
	PlotStatsLegend,
	usePlotLegendHighlight,
	type PlotLegendSeries,
} from "./plot-legend"

// Marks and paint helpers that are not a chart's subject: grid, focus, fills.
export { dashedGridY, type DashedGridYOptions } from "./plot-grid"
export { focusCrosshair, focusDot } from "./plot-focus"
export { roundCapDasharray, useChartId, verticalGradient } from "./plot-paint"
export {
	canvasSafeThresholdColor,
	thresholdRules,
	type PlotThreshold,
	type ThresholdRulesOptions,
} from "./threshold-rules"

// Scales and domains.
export {
	NICE_TICK_COUNT,
	bucketTimeScale,
	integerTickValues,
	linearYDomain,
	linearYScale,
	logYDomain,
	logYScale,
	niceLinearDomain,
	type DomainThreshold,
	type LinearYDomainOptions,
} from "./plot-scales"

// Colour: theme tokens, resolution, and the sequential ramps.
export {
	PLOT_CHROME_TOKENS,
	resolvePlotColor,
	usePlotChromeColors,
	usePlotColors,
	useResolvedSeriesColors,
	type PlotChromeColors,
	type PlotColorToken,
} from "./theme"
export {
	DENSITY_RAMP_TOKENS,
	HEATMAP_RAMP_TOKENS,
	createSequentialColorScale,
	muteColor,
	rampStops,
	resolveSequentialDomain,
	type RampKey,
	type SequentialColorScaleOptions,
	type SequentialScaleType,
} from "./color-scale"

// Series shaping: partial buckets, gaps, stats, visibility.
export {
	findFirstPartialIndex,
	splitAtFirstPartial,
	trimEmptyTrailingBuckets,
	type PartialCandidateRow,
	type PartialSplit,
} from "./partial-buckets"
export { dropNullPoints, type SeriesValue } from "./series-gaps"
export {
	computeSeriesStats,
	isAllZeroStats,
	sortZeroSeriesLast,
	type SeriesStats,
	type StatsSeries,
} from "./series-stats"
export { useSeriesVisibility } from "./series-visibility"
