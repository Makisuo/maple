import type { ChartPoint, ChartValue, DomChartDefinition } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleTime } from "d3-scale"
import * as React from "react"

import { useContainerSize } from "../../hooks/use-container-size"
import {
	formatBucketLabel,
	formatValueByUnit,
	inferBucketSeconds,
	inferRangeMs,
	parseBucketMs,
} from "../../lib/format"
import { resolveSeriesColors } from "../../lib/semantic-series-colors"
import { cn } from "../../lib/utils"
import type { ChartLegendMode } from "../charts/_shared/chart-types"
import { QueryBuilderLegend } from "../charts/_shared/query-builder-legend"
import { hasOnlyIntegerValues } from "../charts/_shared/sparse-series"
import { findFirstPartialIndex } from "./partial-buckets"
import { PlotFrame, usePlotLegendSlot, type PlotFrameProps, type PlotLegendItem } from "./plot-frame"
import {
	NICE_TICK_COUNT,
	bucketTimeScale,
	integerTickValues,
	linearYDomain,
	logYDomain,
	logYScale,
	niceLinearDomain,
	type DomainThreshold,
} from "./plot-scales"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	type PlotTooltipSeries,
	type TooltipFocusStore,
} from "./plot-tooltip"
import { computeSeriesStats, sortZeroSeriesLast, type SeriesStats } from "./series-stats"
import { useSeriesVisibility } from "./series-visibility"
import { usePlotChromeColors, useResolvedSeriesColors, type PlotChromeColors } from "./theme"

/**
 * The part of a query-builder time-series chart that is not about its marks.
 *
 * Line, area and bar differ in how they PAINT a bucket — a stroke, a band, a
 * rect — and agree on everything else: how rows are normalised, how series get
 * their keys and colours, which of them the legend has hidden, what the axes
 * say, and what the tooltip prints. That agreement used to be transcribed per
 * chart, which is how the three of them drifted apart in the Recharts era.
 *
 * The shape a consumer follows is: build the model, build the marks (its own
 * job), assemble the definition with the axis builders here, render `PlotFrame`.
 */

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart (a share page handing over an envelope where an
// array belongs, an empty result) draw plausible-looking curves labelled "A" and
// "B" instead of an empty plot. Gallery thumbnails pass their sample rows in
// explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

// Defense-in-depth render cap: never attempt to draw more than this many series,
// even if a query returns a high-cardinality group-by without a `seriesLimit`.
// The primary guardrail is the query-level top-N cap; this just keeps a runaway
// result set from locking up the browser.
export const HARD_SERIES_LIMIT = 60

/** Used when a series colour token resolves to nothing. */
export const SERIES_FALLBACK_COLOR = "#6366f1"

/** One normalised row: the bucket, its parsed date, and every series value. */
export interface TimeseriesRow extends Record<string, unknown> {
	bucket: string
	/**
	 * Precomputed, because `scaleTime` takes Dates and building one per accessor
	 * call would allocate on every scale pass.
	 */
	date: Date
	partial?: boolean
}

export function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/**
 * A source column, and the key the chart knows it by.
 *
 * The remap exists because a raw group-by value is arbitrary text — it can
 * collide with `bucket`, contain a dot, or be the empty string — while a chart
 * key is read back off row objects by accessors. `s1..sN` are safe by
 * construction, and `rawKey` stays the label the legend and tooltip print.
 */
export interface TimeseriesSeriesDefinition {
	rawKey: string
	chartKey: string
}

export interface NormalisedTimeseries {
	rows: TimeseriesRow[]
	seriesDefinitions: TimeseriesSeriesDefinition[]
}

/**
 * Rows and series definitions from whatever the query returned.
 *
 * Series are discovered in FIRST-SEEN order across all rows, not from the first
 * row alone: a sparse group-by omits a key from buckets where it had no events,
 * so a series that starts halfway through the range would otherwise never be
 * drawn.
 */
export function normaliseTimeseriesRows(
	data: ReadonlyArray<Record<string, unknown>> | undefined,
): NormalisedTimeseries {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS
	const rawSeriesKeys: string[] = []
	const seen = new Set<string>()

	for (const row of source) {
		for (const key of Object.keys(row)) {
			if (key === "bucket" || key === "partial" || seen.has(key)) continue
			seen.add(key)
			rawSeriesKeys.push(key)
		}
	}

	const definitions = rawSeriesKeys.slice(0, HARD_SERIES_LIMIT).map((rawKey, index) => ({
		rawKey,
		chartKey: `s${index + 1}`,
	}))

	const normalised = source.flatMap((row): TimeseriesRow[] => {
		const bucket = typeof row.bucket === "string" ? row.bucket : ""
		const epochMs = parseBucketMs(bucket)
		// A row with no parseable bucket has no position on a time axis. Dropping
		// it is the only honest option: Recharts placed it on a categorical slot,
		// which silently invented an x position for it.
		if (epochMs == null) return []
		const next: TimeseriesRow = { bucket, date: new Date(epochMs) }
		if (row.partial === true) next.partial = true
		for (const definition of definitions) {
			next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
		}
		return [next]
	})

	return { rows: normalised, seriesDefinitions: definitions }
}

/**
 * Rates are stored per bucket and displayed per second.
 *
 * Returns the SAME array when no conversion applies, so a caller's memo on the
 * result keeps its identity and nothing downstream recomputes.
 */
export function scaleTimeseriesRates(
	rows: TimeseriesRow[],
	keys: ReadonlyArray<string>,
	unit: string | undefined,
	bucketSeconds: number | undefined,
): TimeseriesRow[] {
	if (unit !== "requests_per_sec" || !bucketSeconds) return rows
	return rows.map((row) => {
		const next: TimeseriesRow = { bucket: row.bucket, date: row.date }
		if (row.partial) next.partial = true
		for (const key of keys) next[key] = asFiniteNumber(row[key]) / bucketSeconds
		return next
	})
}

/** One series as the marks, legend and tooltip all see it. */
export interface TimeseriesSeries {
	/** Internal chart key (s1, s2, …). */
	key: string
	label: string
	/** A RESOLVED colour literal — canvas cannot read `var()`. */
	color: string
}

/** What `formatBucketLabel` needs to choose a label's precision. */
export interface TimeseriesAxisContext {
	rangeMs: number
	bucketSeconds: number | undefined
	/**
	 * `[first, last]` epoch ms of the buckets actually DRAWN, when the caller
	 * knows them. Lets `timeseriesXAxis` clamp a tick label sitting on a domain
	 * edge instead of letting it overhang — see the `anchor` there.
	 */
	domainMs?: readonly [number, number]
}

/** `[first, last]` epoch ms of `rows`, or `undefined` when there is no span. */
export function rowsDomainMs(rows: ReadonlyArray<{ date: Date }>): readonly [number, number] | undefined {
	if (rows.length === 0) return undefined
	const first = rows[0].date.getTime()
	const last = rows[rows.length - 1].date.getTime()
	if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined
	return [Math.min(first, last), Math.max(first, last)]
}

export interface TimeseriesModelOptions {
	data?: Record<string, unknown>[]
	unit?: string
	/**
	 * Rewrites a series after its colour is resolved — the bar chart's "Other"
	 * bucket, which must not wear the identity hue `resolveSeriesColors` hashes
	 * out of its name.
	 *
	 * Applied INSIDE the model rather than by the chart afterwards so that one
	 * list feeds the marks, the legend, the tooltip and the hoisted header
	 * together. Memoise it: it sits inside the series memo.
	 */
	mapSeries?: (series: TimeseriesSeries) => TimeseriesSeries
}

/**
 * Whether the chart draws its own legend strip.
 *
 * The one place the question is answered, because two things read it: the strip
 * itself, and the decision not to ALSO publish into a host header — a tile
 * showing both would print its series twice.
 */
export function hoistsLegend(legend: ChartLegendMode | undefined): boolean {
	return legend !== "visible" && legend !== "right"
}

export interface TimeseriesModel {
	/** Normalised rows, rate-scaled when the unit calls for it. */
	rows: TimeseriesRow[]
	/** Every series, including the hidden ones — this is the legend's list. */
	series: readonly TimeseriesSeries[]
	/** The series that should be painted. Never empty while `series` isn't. */
	visible: readonly TimeseriesSeries[]
	visibleKeys: readonly string[]
	hidden: ReadonlySet<string>
	toggle: (key: string) => void
	/** Min/Max/Mean/Last per series key, over ALL series. */
	stats: Record<string, SeriesStats>
	bucketSeconds: number | undefined
	axisContext: TimeseriesAxisContext
	chromeColors: PlotChromeColors
	focusStore: TooltipFocusStore
	tooltipSeries: PlotTooltipSeries<TimeseriesRow>[]
	/** Attach to the element that wraps `PlotFrame`. */
	containerRef: React.RefObject<HTMLDivElement | null>
	containerWidth: number
	containerHeight: number
}

/**
 * Everything a query-builder time-series chart needs before it decides how to
 * draw a bucket.
 *
 * One hook rather than a dozen, because the steps are a pipeline with a required
 * order (see `useSeriesVisibility` for why), and splitting it into micro-hooks
 * would let a consumer run them out of order. Every stage keeps its own memo —
 * this sits on the hover hot path, and a dropped boundary is a real regression.
 */
export function useTimeseriesModel({ data, unit, mapSeries }: TimeseriesModelOptions): TimeseriesModel {
	const { rows, seriesDefinitions } = React.useMemo(() => normaliseTimeseriesRows(data), [data])

	const allKeys = React.useMemo(
		() => seriesDefinitions.map((definition) => definition.chartKey),
		[seriesDefinitions],
	)

	const bucketSeconds = React.useMemo(() => inferBucketSeconds(rows), [rows])

	const scaledRows = React.useMemo(
		() => scaleTimeseriesRates(rows, allKeys, unit, bucketSeconds),
		[rows, unit, bucketSeconds, allKeys],
	)

	const colorTokens = React.useMemo(() => {
		const byRawKey = resolveSeriesColors(seriesDefinitions.map((d) => d.rawKey))
		return new Map(
			seriesDefinitions.map((d) => [d.chartKey, byRawKey.get(d.rawKey) ?? SERIES_FALLBACK_COLOR]),
		)
	}, [seriesDefinitions])

	// Tokens, resolved to literals. `resolveSeriesColors` hands back
	// `var(--chart-3)` and friends, which paint on SVG and resolve to NOTHING on
	// canvas — PlotFrame's dev assertion throws on one that slips through.
	const colors = useResolvedSeriesColors(colorTokens, SERIES_FALLBACK_COLOR)

	const chromeColors = usePlotChromeColors()

	/**
	 * The buckets the stats describe: the CLOSED ones.
	 *
	 * An in-flight bucket is usually queried before its data has landed, so it
	 * arrives empty or zero-filled — and a zero that means "not measured yet" is
	 * not a reading. Averaging it in dragged `Mean` down and, far worse, made
	 * `Last` read 0 on a perfectly healthy series, which is the single number a
	 * reader takes off a dashboard tile. The Recharts predecessor got this by
	 * accident: `markIncompleteSegments` moved in-flight values onto `_incomplete`
	 * keys, so the main key was null there and the stats loop skipped it.
	 *
	 * When EVERY bucket is in flight there is nothing closed to report, and four
	 * zeros would be a worse lie than provisional numbers — so that case keeps the
	 * whole range.
	 */
	const statsRows = React.useMemo(() => {
		const first = findFirstPartialIndex(scaledRows)
		return first <= 0 ? scaledRows : scaledRows.slice(0, first)
	}, [scaledRows])

	/**
	 * Stats over ALL series, including hidden ones.
	 *
	 * Computed BEFORE the visibility filter, deliberately: a hidden series keeps
	 * its legend row and its numbers so it can be brought back. See
	 * `useSeriesVisibility` for the rest of that ordering.
	 */
	const stats = React.useMemo(() => computeSeriesStats(statsRows, allKeys), [statsRows, allKeys])

	const series = React.useMemo(() => {
		const resolved = seriesDefinitions.map((definition) => ({
			key: definition.chartKey,
			label: definition.rawKey,
			color: colors.get(definition.chartKey) ?? SERIES_FALLBACK_COLOR,
		}))
		return mapSeries ? resolved.map(mapSeries) : resolved
	}, [seriesDefinitions, colors, mapSeries])

	const { hidden, toggle, visible, visibleKeys } = useSeriesVisibility(series)

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width: containerWidth, height: containerHeight } = useContainerSize(containerRef)

	const axisContext = React.useMemo(
		() => ({
			rangeMs: inferRangeMs(scaledRows),
			bucketSeconds,
			domainMs: rowsDomainMs(scaledRows),
		}),
		[scaledRows, bucketSeconds],
	)

	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])

	const tooltipSeries = React.useMemo<PlotTooltipSeries<TimeseriesRow>[]>(
		() => timeseriesTooltipSeries(visible, unit),
		[visible, unit],
	)

	return React.useMemo(
		() => ({
			rows: scaledRows,
			series,
			visible,
			visibleKeys,
			hidden,
			toggle,
			stats,
			bucketSeconds,
			axisContext,
			chromeColors,
			focusStore,
			tooltipSeries,
			containerRef,
			containerWidth,
			containerHeight,
		}),
		[
			scaledRows,
			series,
			visible,
			visibleKeys,
			hidden,
			toggle,
			stats,
			bucketSeconds,
			axisContext,
			chromeColors,
			focusStore,
			tooltipSeries,
			containerWidth,
			containerHeight,
		],
	)
}

/**
 * The x axis every bucketed chart shares.
 *
 * A d3 TIME scale over the precomputed `row.date`. A point scale over
 * bucket strings — which is what the categorical Recharts axis was —
 * puts ticks on arbitrary buckets ("08:25 PM") instead of clock
 * boundaries. `scaleTime`, not `scaleUtc`: the labels below render in
 * local time, and only local ticks land on locally round boundaries.
 *
 * The bare FACTORY, so the domain is inferred. That is safe even though
 * the solid and dashed marks each cover a slice: a continuous domain is
 * min/max over the union, and the slices overlap at the bridge row.
 */
export function timeseriesXAxis(axisContext: TimeseriesAxisContext) {
	return {
		scale: scaleTime,
		axis: {
			line: false,
			ticks: {
				size: 0,
				padding: 8,
				// 72px put "01:00 AM 01:30 AM 02:00 AM" almost edge to edge on a card:
				// a bucket label runs ~55px, so the gap between two of them was single
				// digits. Widening the CANDIDATE spacing is what buys the room without
				// touching how the labels are chosen — the scale still lands them on
				// round clock boundaries, evenly spaced.
				spacing: 104,
				format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
			},
			// The port's missing `minTickGap={24}`. Thinning is the backstop, not the
			// spacing mechanism: it drops colliding labels — at a 4px default, almost
			// none — and a thinned time axis reads unevenly (01:00, 02:00, 03:30). A
			// gap wide enough to be legible, left to fire only where a long label or a
			// narrow tile still collides.
			tickLabels: { thin: { minGap: 12 }, anchor: edgeTickAnchor(axisContext) },
		},
	}
}

/**
 * Keeps the end tick labels inside the plot instead of overhanging it.
 *
 * A tick label is centred on its tick, so one near a domain edge hangs half its
 * width past the plot. The layout solver measures that overhang and reserves it
 * as margin (`includeLabelMargin` in the library's `scene.js`), which pulls the
 * plot's edge inward by half a label — measured at 49px on a 672px card for
 * "Aug 19, 12:00 AM", against 4px when no tick lands near the edge. The series
 * then stops well short of where its own axis labels run, which is what reads as
 * a chart that has been cut off.
 *
 * Whether it bites is pure tick PHASE, which is why it looks intermittent: a
 * 6-day window ending at midnight puts a 2-day tick on the last bucket, while a
 * 7-day one lands the ticks a day inside and nothing overhangs.
 *
 * The threshold is HALF A LABEL, not one bucket: the tick that triggered this in
 * production sat two hours inside a six-day domain — a rounding error in bucket
 * terms, and still 45px of overhang. Half a label is converted to a fraction of
 * the domain against a NOMINAL plot width rather than a measured one, because
 * the measurement is the solver's output and reading it here would make the
 * layout depend on its own result. Over-estimating is the safe direction (it
 * anchors a label that would have just fitted) and the error is bounded: label
 * candidates are `spacing: 104` apart and a label is ~90px, so at most one tick
 * per edge can ever fall inside the threshold.
 */
const NOMINAL_PLOT_WIDTH = 600
/** Half the advance width of one character of the 11px mono tick label. */
const HALF_CHAR_PX = 2.8
/** A label can never be wide enough to claim this much of the domain. */
const MAX_EDGE_FRACTION = 0.2

function edgeTickAnchor(axisContext: TimeseriesAxisContext) {
	const domain = axisContext.domainMs
	if (!domain) return undefined
	const spanMs = domain[1] - domain[0]
	if (spanMs <= 0) return undefined

	return ({ value }: { value: Date }): "start" | "middle" | "end" => {
		const at = value.getTime()
		if (!Number.isFinite(at)) return "middle"

		const label = formatBucketLabel(value.toISOString(), axisContext, "tick")
		const fraction = Math.min(MAX_EDGE_FRACTION, (label.length * HALF_CHAR_PX) / NOMINAL_PLOT_WIDTH)
		const slackMs = spanMs * fraction

		if (at >= domain[1] - slackMs) return "end"
		if (at <= domain[0] + slackMs) return "start"
		return "middle"
	}
}

/**
 * The x axis for a chart whose marks have WIDTH — the bar chart.
 *
 * Same ticks and same clock as `timeseriesXAxis`, over a domain padded by half a
 * bucket at each end. A bar is drawn centred on its bucket at
 * `centre - bandwidth / 2` (`dist/bar.js`), so against the unpadded domain — which
 * ends exactly at the first and last timestamps — half of the first column lands
 * in the y-axis tick-label gutter and half of the last one past the plot's right
 * edge. Measured at 24px each way on a 6-bucket 800px chart, and 74px once a
 * grouped layout widens the band; the overhang is worst exactly where bars are
 * chunkiest, which is the low-bucket-count dashboard tile.
 *
 * PADDING rather than `clip: true`, which is the other available lever:
 * - Clipping would slice those columns in half rather than place them. Recharts'
 *   categorical axis reserved a whole band per bucket, so both end columns were
 *   drawn WHOLE and inside the plot — padding reproduces that, clipping does not.
 * - `clip` is a chart-level flag, so it would also cut the threshold rules and
 *   their labels, which are meant to span the plot.
 * Half a bucket is exactly the slot a band scale would have reserved, and it
 * comfortably covers the widest a bar can get (0.4 × the bucket gap).
 *
 * Line and area deliberately keep the unpadded `timeseriesXAxis`: their marks
 * have no width, so padding there would just inset the series from the plot
 * edges and waste the plot.
 */
export function timeseriesBandXAxis(axisContext: TimeseriesAxisContext, rows: readonly TimeseriesRow[]) {
	const domain = bucketBandDomain(rows, axisContext.bucketSeconds)
	// No usable spacing — a single bucket, or an unparseable one. Inferring is
	// then no worse than a padding guess, and `barY` has its own single-position
	// fallback for the bandwidth.
	if (!domain) return timeseriesXAxis(axisContext)
	return { ...timeseriesXAxis(axisContext), scale: bucketTimeScale(domain) }
}

/**
 * `[first - half a bucket, last + half a bucket]`, or `null` when the bucket
 * spacing cannot be established.
 *
 * The interval comes from `bucketSeconds` when the caller knows it and from the
 * smallest observed gap otherwise — the smallest, because that is also what
 * `inferBandwidth` measures, so the padding and the bar width are derived from
 * the same number even when a range has a ragged bucket in it.
 */
export function bucketBandDomain(
	rows: readonly TimeseriesRow[],
	bucketSeconds: number | undefined,
): [Date, Date] | null {
	if (rows.length < 2) return null

	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY
	let smallestGap = Number.POSITIVE_INFINITY
	let previous: number | null = null

	for (const row of rows) {
		const time = row.date.getTime()
		if (!Number.isFinite(time)) continue
		if (time < min) min = time
		if (time > max) max = time
		if (previous != null && time > previous) smallestGap = Math.min(smallestGap, time - previous)
		previous = time
	}

	if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null
	const interval =
		bucketSeconds != null && bucketSeconds > 0
			? bucketSeconds * 1000
			: Number.isFinite(smallestGap)
				? smallestGap
				: 0
	if (interval <= 0) return null

	return [new Date(min - interval / 2), new Date(max + interval / 2)]
}

export interface TimeseriesYAxisOptions {
	rows: ReadonlyArray<Record<string, unknown>>
	/** The VISIBLE series keys — hidden series must not widen the axis. */
	visibleKeys: ReadonlyArray<string>
	unit?: string
	logScale?: boolean
	softMin?: number
	softMax?: number
	fitYAxisToData?: boolean
	thresholds?: ReadonlyArray<DomainThreshold>
	/** Sums the visible keys per row, for the stacked area and bar charts. */
	stacked?: boolean
	/**
	 * Overrides the tick label formatter.
	 *
	 * `unit` covers the query-builder charts, whose units come off a persisted
	 * widget config and go through `formatValueByUnit`. The fixed-metric charts
	 * have no such config and their own long-standing formatters — `formatLatency`
	 * is not `formatValueByUnit(v, "duration_ms")`, and a throughput tick carries
	 * a rate suffix derived from the bucket size. Passing the function is what
	 * keeps them on the shared axis instead of hand-rolling one each.
	 */
	format?: (value: number) => string
}

/**
 * The y axis every bucketed chart shares, domain included.
 *
 * The domain is computed here rather than handed in because everything that
 * consumes it — the scale, the integer tick values, and a stacked chart's band
 * floor — has to agree, and letting them disagree is the bug. `y` is the chart
 * definition's axis field; `domain` is that same resolved `[min, max]`, returned
 * so a mark that must fill FROM THE AXIS FLOOR reads the floor the axis actually
 * used instead of recomputing it. Zero is the wrong guess under
 * `fitYAxisToData`/`softMin`, and fatal under log, where `scales.y.map(0)` is
 * `-Infinity` and `configured-scale.js` does no clamping.
 */
export function timeseriesYAxis(options: TimeseriesYAxisOptions) {
	const {
		rows,
		visibleKeys,
		unit,
		logScale,
		softMin,
		softMax,
		fitYAxisToData,
		thresholds,
		stacked,
		format,
	} = options

	const dataDomain = linearYDomain({
		rows,
		keys: visibleKeys,
		stacked,
		fitYAxisToData: fitYAxisToData && softMin == null && !logScale,
		softMin,
		softMax,
		thresholds,
	})
	// A log axis does not use the data floor — it pins its own at 1. Both branches
	// go through `logYDomain`, so the returned domain and the scale below cannot
	// describe different axes.
	//
	// The linear branch is NICED here rather than left to the renderer, because
	// the renderer nices a pinned domain too (`resolveScaleInput`) — so a caller
	// reading `domain` back to fill a band from the axis floor would otherwise be
	// describing an axis nobody draws. See `niceLinearDomain`.
	const domain: [number, number] = logScale ? logYDomain(dataDomain[1]) : niceLinearDomain(dataDomain)
	// A supplied formatter is as much a statement that the values carry a unit as
	// `unit` itself is — a latency axis whose ticks read "12.0ms" must not have
	// its tick VALUES snapped to integers behind the formatter's back.
	const integerOnly = hasOnlyIntegerValues(rows, visibleKeys) && unit == null && format == null

	return {
		domain,
		y: {
			// The domain lives on the SCALE — `ChartAxisOptions` has no `domain`
			// field, and an instance is what pins it (a bare factory infers, which
			// is how the zero anchor gets lost).
			scale: logScale ? logYScale(dataDomain[1]) : scaleLinear().domain(domain),
			// A COUNT, not `true`: `true` lets the renderer derive the nice count
			// from the plot's pixel height, so the domain computed above and the
			// axis drawn would agree only at some window sizes.
			nice: logScale ? false : NICE_TICK_COUNT,
			// No `grid` — the built-in one is solid and nothing dashes it. Every
			// chart on this axis emits `dashedGridY()` as its first mark instead;
			// see `plot-grid.ts`.
			axis: {
				line: false,
				// There is no `allowDecimals`; integer-only data supplies its tick
				// values outright so counts never render as "1.5". `undefined` leaves
				// the library to choose.
				ticks: {
					size: 0,
					padding: 6,
					values: integerOnly && !logScale ? integerTickValues(domain) : undefined,
					format: format ?? ((value: number) => formatValueByUnit(value, unit)),
				},
			},
		},
	}
}

/**
 * One tooltip row per visible series.
 *
 * `position` is how a stacked chart tells the card where its bands were actually
 * painted; a chart that plots the raw value omits it. Built here rather than in
 * each chart so the label, colour and unit formatting stay one decision.
 */
export function timeseriesTooltipSeries(
	visible: readonly TimeseriesSeries[],
	unit: string | undefined,
	position?: (row: TimeseriesRow, key: string) => number,
): PlotTooltipSeries<TimeseriesRow>[] {
	return visible.map((entry) => ({
		label: entry.label,
		color: entry.color,
		value: (row: TimeseriesRow) => {
			const value = row[entry.key]
			return typeof value === "number" ? value : null
		},
		format: (value: number) => formatValueByUnit(value, unit),
		position: position && ((row: TimeseriesRow) => position(row, entry.key)),
	}))
}

/**
 * The model, shared with every `Timeseries.*` part below.
 *
 * Before this, each chart threaded `model` by hand into three free functions
 * that returned JSX — `timeseriesLegend(model, …)`, `timeseriesTooltipBody(model,
 * points)`. Those had no memo boundary, no hooks, and no identity React could
 * reconcile, so the legend rebuilt on every chart render no matter what.
 */
const TimeseriesContext = React.createContext<TimeseriesModel | null>(null)

function useTimeseriesModelContext(): TimeseriesModel {
	const model = React.use(TimeseriesContext)
	if (!model) throw new Error("Timeseries parts must render inside <Timeseries.Provider>")
	return model
}

function TimeseriesProvider({ model, children }: { model: TimeseriesModel; children: React.ReactNode }) {
	return <TimeseriesContext value={model}>{children}</TimeseriesContext>
}

export interface TimeseriesTooltipProps {
	points: readonly ChartPoint<TimeseriesRow, ChartValue, number>[]
	/**
	 * Replaces `model.tooltipSeries`, for a chart whose marks do not sit at their
	 * raw values — see `timeseriesTooltipSeries`. Memoise it: this runs on every
	 * tooltip update.
	 */
	series?: readonly PlotTooltipSeries<TimeseriesRow>[]
}

/** The tooltip card's contents. */
function TimeseriesTooltipBody({ points, series }: TimeseriesTooltipProps) {
	const model = useTimeseriesModelContext()
	return (
		<PlotTooltipBody
			points={points}
			series={series ?? model.tooltipSeries}
			focusStore={model.focusStore}
			heading={(row: TimeseriesRow) => formatBucketLabel(row.bucket, model.axisContext, "tooltip")}
		/>
	)
}

export interface TimeseriesLegendProps {
	mode: ChartLegendMode | undefined
	/** Adds the per-series Min/Max/Mean/Last table. */
	seriesStats?: boolean
	unit?: string
}

/**
 * The legend, in WHICHEVER form the mode calls for — a strip this chart draws,
 * or a payload published into an ancestor's slot.
 *
 * One component owns both arms because they are one decision. They used to be
 * two: `useTimeseriesModel` published to the slot when `hoistsLegend(legend)`,
 * and `timeseriesLegend` drew the strip when `legend !== "visible" && legend
 * !== "right"` — the same predicate, written twice, in complementary form, in
 * two modules. A chart that forgot to thread `legend` into the model got both
 * arms at once and printed its series twice, which is why the line chart still
 * carries a comment warning about it.
 *
 * Renders `null` in the hoisting case rather than being absent: `PlotFrame`
 * reserves its legend row for anything non-null, and an empty row is 0px under
 * `shrink-0`, so the layout is unchanged and the chart no longer has to answer
 * the same question a second time to decide whether to pass this at all.
 */
function TimeseriesLegend({ mode, seriesStats, unit }: TimeseriesLegendProps) {
	const model = useTimeseriesModelContext()
	const hoist = hoistsLegend(mode)

	/**
	 * Memoised on `series`, which is stable across hovers, so the host's
	 * `setState` cannot land on the pointer path.
	 */
	const items = React.useMemo<PlotLegendItem[] | null>(
		() =>
			hoist
				? model.series.map((entry) => ({
						key: entry.key,
						label: entry.label,
						color: entry.color,
					}))
				: null,
		[model.series, hoist],
	)
	usePlotLegendSlot(items)

	// Sorted HERE and nowhere else: all-zero series sink to the bottom so they
	// cannot bury the ones carrying data (MAP-49), while `model.series` and
	// `model.visible` keep their order because they are paint order and stack
	// order.
	const sorted = React.useMemo(
		() => sortZeroSeriesLast(model.series, model.stats),
		[model.series, model.stats],
	)

	if (hoist) return null
	return (
		<QueryBuilderLegend
			series={sorted}
			stats={model.stats}
			hidden={model.hidden}
			onToggle={model.toggle}
			unit={unit}
			layout={mode === "right" ? "right" : "bottom"}
			variant={seriesStats ? "stats" : "compact"}
			maxHeight={mode === "right" ? model.containerHeight : undefined}
		/>
	)
}

/**
 * Where a legend mode puts the strip.
 *
 * `"right"` is a PLACEMENT, and until this existed nothing told `PlotFrame` so:
 * every timeseries chart passed the legend and left `legendPlacement` at its
 * `"bottom"` default, so `legend="right"` rendered `QueryBuilderLegend`'s
 * vertical column — height-capped to the container, one series per row — and
 * then stacked it UNDER the plot. That is the exact regression `PlotFrame`
 * documents `"right"` as having been added to fix.
 */
export function legendPlacementFor(mode: ChartLegendMode | undefined): "bottom" | "right" {
	return mode === "right" ? "right" : "bottom"
}

export interface TimeseriesFrameProps<TDatum> {
	definition: DomChartDefinition<TDatum, ChartValue, number>
	ariaLabel?: string
	className?: string
	legend?: ChartLegendMode
	seriesStats?: boolean
	unit?: string
	/**
	 * Replaces the default tooltip body, for a chart whose datum is not a row —
	 * the bar chart, where one datum is a CELL.
	 */
	renderTooltipBody?: PlotFrameProps<TDatum, ChartValue, number>["renderTooltipBody"]
	/** Replaces `model.tooltipSeries`, for marks that do not sit at raw values. */
	tooltipSeries?: readonly PlotTooltipSeries<TimeseriesRow>[]
}

/**
 * The plot, its legend and its tooltip, wired to the model in context.
 *
 * This is the whole tail of a query-builder time-series chart. Each of the
 * three used to open-code it: the same measured wrapper div, the same
 * `ariaLabel`, and three hand-threaded `model` arguments — which is how the
 * `legendPlacement` bug above survived in all three at once.
 */
function TimeseriesFrame<TDatum>({
	definition,
	ariaLabel = "Time series",
	className,
	legend,
	seriesStats,
	unit,
	renderTooltipBody,
	tooltipSeries,
}: TimeseriesFrameProps<TDatum>) {
	const model = useTimeseriesModelContext()
	return (
		<div ref={model.containerRef} className={cn("h-full w-full", className)}>
			<PlotFrame
				className="h-full w-full"
				ariaLabel={ariaLabel}
				definition={definition}
				legend={<TimeseriesLegend mode={legend} seriesStats={seriesStats} unit={unit} />}
				legendPlacement={legendPlacementFor(legend)}
				renderTooltipBody={
					renderTooltipBody ??
					(({ points }) => (
						<TimeseriesTooltipBody
							points={points as readonly ChartPoint<TimeseriesRow, ChartValue, number>[]}
							series={tooltipSeries}
						/>
					))
				}
			/>
		</div>
	)
}

/**
 * The compound surface a query-builder time-series chart composes.
 *
 * A chart builds its own marks — that is the one thing line, area and bar do
 * not share — and composes everything else from here.
 */
export const Timeseries = {
	Provider: TimeseriesProvider,
	Frame: TimeseriesFrame,
	Legend: TimeseriesLegend,
	TooltipBody: TimeseriesTooltipBody,
}
