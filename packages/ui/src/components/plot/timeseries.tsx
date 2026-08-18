import type { ChartPoint, ChartValue } from "@tanstack/charts"
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
import type { ChartLegendMode } from "../charts/_shared/chart-types"
import { QueryBuilderLegend } from "../charts/_shared/query-builder-legend"
import { hasOnlyIntegerValues } from "../charts/_shared/sparse-series"
import { integerTickValues, linearYDomain, logYDomain, logYScale, type DomainThreshold } from "./plot-scales"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	type PlotTooltipSeries,
	type TooltipFocusStore,
} from "./plot-tooltip"
import { computeSeriesStats, type SeriesStats } from "./series-stats"
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
}

export interface TimeseriesModelOptions {
	data?: Record<string, unknown>[]
	unit?: string
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
export function useTimeseriesModel({ data, unit }: TimeseriesModelOptions): TimeseriesModel {
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
	 * Stats over ALL series, including hidden ones.
	 *
	 * Computed BEFORE the visibility filter, deliberately: a hidden series keeps
	 * its legend row and its numbers so it can be brought back. See
	 * `useSeriesVisibility` for the rest of that ordering.
	 */
	const stats = React.useMemo(() => computeSeriesStats(scaledRows, allKeys), [scaledRows, allKeys])

	const series = React.useMemo(
		() =>
			seriesDefinitions.map((definition) => ({
				key: definition.chartKey,
				label: definition.rawKey,
				color: colors.get(definition.chartKey) ?? SERIES_FALLBACK_COLOR,
			})),
		[seriesDefinitions, colors],
	)

	const { hidden, toggle, visible, visibleKeys } = useSeriesVisibility(series)

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width: containerWidth, height: containerHeight } = useContainerSize(containerRef)

	const axisContext = React.useMemo(
		() => ({ rangeMs: inferRangeMs(scaledRows), bucketSeconds }),
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
				spacing: 72,
				format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
			},
		},
	}
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
	const { rows, visibleKeys, unit, logScale, softMin, softMax, fitYAxisToData, thresholds, stacked } =
		options

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
	const domain: [number, number] = logScale ? logYDomain(dataDomain[1]) : dataDomain
	const integerOnly = hasOnlyIntegerValues(rows, visibleKeys) && unit == null

	return {
		domain,
		y: {
			// The domain lives on the SCALE — `ChartAxisOptions` has no `domain`
			// field, and an instance is what pins it (a bare factory infers, which
			// is how the zero anchor gets lost).
			scale: logScale ? logYScale(dataDomain[1]) : scaleLinear().domain(domain),
			nice: !logScale,
			grid: true,
			axis: {
				line: false,
				// There is no `allowDecimals`; integer-only data supplies its tick
				// values outright so counts never render as "1.5". `undefined` leaves
				// the library to choose.
				ticks: {
					size: 0,
					padding: 6,
					values: integerOnly && !logScale ? integerTickValues(domain) : undefined,
					format: (value: number) => formatValueByUnit(value, unit),
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

export interface TimeseriesTooltipOptions {
	/**
	 * Replaces `model.tooltipSeries`, for a chart whose marks do not sit at their
	 * raw values — see `timeseriesTooltipSeries`. Memoise it: this runs on every
	 * tooltip update.
	 */
	series?: readonly PlotTooltipSeries<TimeseriesRow>[]
}

/**
 * The tooltip card's contents.
 *
 * A function rather than a component so the chart can hand it straight to
 * `PlotFrame`'s `renderTooltipBody` callback, which is where the points arrive.
 */
export function timeseriesTooltipBody(
	model: TimeseriesModel,
	points: readonly ChartPoint<TimeseriesRow, ChartValue, number>[],
	{ series }: TimeseriesTooltipOptions = {},
) {
	return (
		<PlotTooltipBody
			points={points}
			series={series ?? model.tooltipSeries}
			focusStore={model.focusStore}
			heading={(row: TimeseriesRow) => formatBucketLabel(row.bucket, model.axisContext, "tooltip")}
		/>
	)
}

export interface TimeseriesLegendOptions {
	legend: ChartLegendMode | undefined
	/** Adds the per-series Min/Max/Mean/Last table. */
	seriesStats?: boolean
	unit?: string
	/**
	 * Replaces `model.series`, for a chart that repaints a series before drawing
	 * it — the bar chart's "Other" bucket, which must not wear the identity hue
	 * `resolveSeriesColors` hashes out of its name. The keys must still be the
	 * model's, since they are what `toggle` and `stats` are keyed by.
	 */
	series?: readonly TimeseriesSeries[]
}

/**
 * The legend strip, or `undefined` when there is none.
 *
 * `undefined` rather than an empty node on purpose: `PlotFrame` only reserves
 * the strip's flex row when it is handed something, so a hidden legend has to be
 * absent, not empty.
 */
export function timeseriesLegend(
	model: TimeseriesModel,
	{ legend, seriesStats, unit, series }: TimeseriesLegendOptions,
) {
	if (legend !== "visible" && legend !== "right") return undefined
	return (
		<QueryBuilderLegend
			series={series ?? model.series}
			stats={model.stats}
			hidden={model.hidden}
			onToggle={model.toggle}
			unit={unit}
			layout={legend === "right" ? "right" : "bottom"}
			variant={seriesStats ? "stats" : "compact"}
			maxHeight={legend === "right" ? model.containerHeight : undefined}
		/>
	)
}
