import { areaY, d3Curve, defineChart, dot, lineY } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"
import * as React from "react"

import {
	Timeseries,
	UNBOUNDED_FOCUS_DISTANCE,
	asFiniteNumber,
	cursorTooltip,
	dashedGridY,
	findFirstPartialIndex,
	focusCrosshair,
	focusDot,
	roundCapDasharray,
	splitAtFirstPartial,
	thresholdRules,
	timeseriesTooltipSeries,
	timeseriesXAxis,
	timeseriesYAxis,
	trimEmptyTrailingBuckets,
	useChartId,
	useTimeseriesModel,
	verticalGradient,
	type TimeseriesRow,
	type TimeseriesSeries,
} from "../../plot"
import type { QueryBuilderAreaChartProps } from "../_shared/chart-types"
import { isolatedPointIndexes, pointsFit } from "../_shared/sparse-series"

/** The top-edge stroke on an unstacked band, and on the line/dot layers. */
const STROKE_WIDTH = 2
/** The dashed edge of a stacked band's in-flight tail — thinner, see below. */
const STACKED_STROKE_WIDTH = 1

/**
 * `areaY` defaults `fillOpacity` to 0.2, which is far fainter than the Recharts
 * `<Area>` default of 0.6 these charts were tuned against. Every fill below
 * states its opacity so the picture does not depend on a library default.
 */
const AREA_FILL_OPACITY = 0.6
const STACKED_FILL_OPACITY = 0.55
const PARTIAL_STACKED_FILL_OPACITY = 0.2

/** The gradient stops of a closed band, and of an in-flight one. */
const FILL_GRADIENT = [0.8, 0.1] as const
const PARTIAL_FILL_GRADIENT = [0.15, 0] as const

/**
 * Per row, the y value each visible band STARTS at — its stacked offset.
 *
 * Keyed by row OBJECT identity rather than by index, because the partial split
 * hands the dashed mark a slice of the same array: the tail rows are the very
 * objects that were measured here, so their bands line up with the solid run's
 * without a second pass or index arithmetic.
 *
 * Bands accumulate in `visible` order, so the first series sits on the axis —
 * the same bottom-up order Recharts gave a shared `stackId`. Hidden series are
 * absent from `visible`, so hiding one restacks the rest instead of leaving a
 * gap, which is what `<Area hide>` did.
 */
type StackBases = ReadonlyMap<TimeseriesRow, Readonly<Record<string, number>>>

function computeStackBases(rows: readonly TimeseriesRow[], visible: readonly TimeseriesSeries[]): StackBases {
	const bases = new Map<TimeseriesRow, Record<string, number>>()
	for (const row of rows) {
		const perKey: Record<string, number> = {}
		let total = 0
		for (const entry of visible) {
			perKey[entry.key] = total
			total += asFiniteNumber(row[entry.key])
		}
		bases.set(row, perKey)
	}
	return bases
}

export function QueryBuilderAreaChart({
	data,
	className,
	legend,
	seriesStats: showStats,
	tooltip,
	stacked,
	curveType,
	unit,
	logScale,
	softMin,
	softMax,
	fitYAxisToData,
	thresholds,
	showPoints,
}: QueryBuilderAreaChartProps) {
	const model = useTimeseriesModel({ data, unit })
	const { rows, visible, visibleKeys, chromeColors, axisContext, focusStore, containerWidth } = model

	const gradientPrefix = useChartId("qbArea")

	/**
	 * The buckets this chart actually draws.
	 *
	 * A trailing in-flight bucket that reported nothing is dropped — see
	 * `trimEmptyTrailingBuckets`. Everything downstream has to agree on that, and
	 * that is the part that was missed: the bands were built from the trimmed
	 * slices while the focus dots were still built over `rows`, and a mark's
	 * channels feed scale inference. So the x axis kept running out to a bucket
	 * nothing painted, and that phantom slot stayed hoverable with a zero-value
	 * tooltip an hour past the end of the data.
	 */
	const plotRows = React.useMemo(() => {
		const first = findFirstPartialIndex(rows)
		return first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)
	}, [rows, visibleKeys])

	const bases = React.useMemo(
		() => (stacked ? computeStackBases(plotRows, visible) : null),
		[stacked, plotRows, visible],
	)

	const yAxis = React.useMemo(
		() =>
			timeseriesYAxis({
				rows: plotRows,
				visibleKeys,
				unit,
				logScale,
				softMin,
				softMax,
				fitYAxisToData,
				thresholds,
				stacked,
			}),
		[plotRows, visibleKeys, unit, logScale, softMin, softMax, fitYAxisToData, thresholds, stacked],
	)

	/**
	 * A line needs no baseline; a band does — it fills from the axis floor, and
	 * that floor is the domain minimum, not zero (`fitYAxisToData` and `softMin`
	 * both move it, and a log axis floors at 1 where zero maps to -Infinity and
	 * would blow up the path). Read off the axis rather than recomputed beside it,
	 * so the two cannot drift apart.
	 */
	const yDomainFloor = yAxis.domain[0]

	/**
	 * A band's floor: its stacked offset, or the axis floor when unstacked.
	 * Clamped so a stack that starts below a fitted/log domain is drawn from the
	 * axis rather than off the bottom of the plot.
	 */
	const baseOf = React.useCallback(
		(row: TimeseriesRow, key: string) => Math.max(yDomainFloor, bases?.get(row)?.[key] ?? 0),
		[bases, yDomainFloor],
	)

	/**
	 * A band's top edge — the value plus everything stacked beneath it. This is
	 * also where the focus dot, the point dots and the tooltip's row highlight
	 * belong: on a stack the raw value is not a position on the axis, it is a
	 * thickness.
	 */
	const topOf = React.useCallback(
		(row: TimeseriesRow, key: string) =>
			Math.max(yDomainFloor, (bases?.get(row)?.[key] ?? 0) + asFiniteNumber(row[key])),
		[bases, yDomainFloor],
	)

	const tooltipSeries = React.useMemo(
		() => timeseriesTooltipSeries(visible, unit, topOf),
		[visible, unit, topOf],
	)

	/** Which points carry a dot — every one, only the isolated ones, or none. */
	const dotIndexes = React.useMemo<ReadonlyMap<string, ReadonlySet<number>>>(() => {
		if (showPoints === false) return new Map()
		// Auto: dots on every point only when they fit the width, otherwise only on
		// the isolated points a band cannot show at all.
		if (showPoints === true || pointsFit(containerWidth, plotRows.length)) {
			const every = new Set(plotRows.map((_, index) => index))
			return new Map(visibleKeys.map((key) => [key, every]))
		}
		return isolatedPointIndexes(plotRows, visibleKeys)
	}, [showPoints, plotRows, containerWidth, visibleKeys])

	const definition = React.useMemo(() => {
		// The in-flight tail is a SECOND pair of marks over an overlapping slice,
		// not a dash pattern on the first. `areaY` has no `strokeDasharray` at all
		// and `lineY`'s is a scalar rather than a per-datum channel, so no single
		// mark can change style mid-series.
		const { solid, dashed } = splitAtFirstPartial(plotRows, visibleKeys)

		// `curve` takes a ChartCurve, not a string. Linear is the default shape, so
		// only monotone needs one built.
		const curve = curveType === "monotone" ? d3Curve(curveMonotoneX) : undefined
		// `lineY` hard-codes a round cap, which eats the gap — see `roundCapDasharray`.
		const partialDash = roundCapDasharray(4, 4, stacked ? STACKED_STROKE_WIDTH : STROKE_WIDTH)

		const gradientIdFor = (key: string, partial: boolean) =>
			`${gradientPrefix}-${key}${partial ? "-partial" : ""}`

		/**
		 * Stacked bands use a FLAT fill: a vertical gradient is computed in plot
		 * space, not band space, so a band high in the stack would render as the
		 * faint tail of its own gradient regardless of how thick it is.
		 */
		const fillFor = (entry: TimeseriesSeries, partial: boolean) =>
			stacked ? entry.color : `url(#${gradientIdFor(entry.key, partial)})`

		const fillOpacityFor = (partial: boolean) => {
			if (!stacked) return AREA_FILL_OPACITY
			return partial ? PARTIAL_STACKED_FILL_OPACITY : STACKED_FILL_OPACITY
		}

		const gradients = [
			...(stacked
				? []
				: visible.map((entry) =>
						verticalGradient(gradientIdFor(entry.key, false), entry.color, ...FILL_GRADIENT),
					)),
			...(stacked || dashed.length === 0
				? []
				: visible.map((entry) =>
						verticalGradient(
							gradientIdFor(entry.key, true),
							entry.color,
							...PARTIAL_FILL_GRADIENT,
						),
					)),
		]

		/**
		 * The band itself, fill only.
		 *
		 * `stroke: "none"` is not a workaround for a missing option — `areaY`
		 * strokes the CLOSED polygon (top edge, baseline and both verticals), which
		 * is still true at 0.14.0 (`dist/area.js` emits `points: [...top,
		 * ...reversed bottom]` and the renderers close the path). A fill-only area
		 * with a `lineY` over its top edge is the composition the package's own
		 * examples use, and it is the only way to get a top-edge-only stroke.
		 */
		const band = (rowSlice: readonly TimeseriesRow[], entry: TimeseriesSeries, partial: boolean) =>
			areaY(rowSlice, {
				id: partial ? `${entry.key}-partial-area` : `${entry.key}-area`,
				x: (row: TimeseriesRow) => row.date,
				y: (row: TimeseriesRow) => topOf(row, entry.key),
				// An explicit extent, so the band's floor is ours rather than a
				// library stack layout's. `areaY` THROWS if `y1`/`y2` are combined
				// with `layout`, and its own layout stacks through the `z` channel
				// over long-format rows — a shape these wide bucket rows are not in,
				// and one that would cost the per-series colour literals too.
				y1: (row: TimeseriesRow) => baseOf(row, entry.key),
				fill: fillFor(entry, partial),
				fillOpacity: fillOpacityFor(partial),
				stroke: "none",
				curve,
			})

		/**
		 * The top-edge stroke.
		 *
		 * Stacked bands carry none on the closed run: whichever series lands on top
		 * would otherwise outline the whole stack silhouette in its own colour,
		 * even when its own band is a sub-pixel sliver. Layers separate by fill
		 * instead. The in-flight tail is the exception — a faded fill alone reads
		 * as missing data rather than as provisional data, so it keeps a thin
		 * dashed edge to say "still filling".
		 */
		const edge = (rowSlice: readonly TimeseriesRow[], entry: TimeseriesSeries, partial: boolean) =>
			lineY(rowSlice, {
				id: partial ? `${entry.key}-partial` : entry.key,
				x: (row: TimeseriesRow) => row.date,
				y: (row: TimeseriesRow) => topOf(row, entry.key),
				stroke: entry.color,
				strokeWidth: stacked ? STACKED_STROKE_WIDTH : STROKE_WIDTH,
				curve,
				strokeDasharray: partial ? partialDash : undefined,
			})

		const hasDashed = dashed.length > 0

		return defineChart({
			gradients,
			marks: [
				dashedGridY(),
				...thresholdRules(thresholds ?? [], { labelX: plotRows.at(-1)?.date }),
				...visible.map((entry) => band(solid, entry, false)),
				...(hasDashed ? visible.map((entry) => band(dashed, entry, true)) : []),
				...(stacked ? [] : visible.map((entry) => edge(solid, entry, false))),
				...(hasDashed ? visible.map((entry) => edge(dashed, entry, true)) : []),
				...visible.flatMap((entry) => {
					const indexes = dotIndexes.get(entry.key)
					if (!indexes || indexes.size === 0) return []
					// Dots cover the SOLID run only. Recharts got this for free — its
					// solid series was null across the in-flight region, so the dot
					// renderer never ran there — and it matters more than it looks: a
					// dashboard tile's partial tail is one bucket wide, so a dot at each
					// end fills the dashes in and the tail reads as a solid edge.
					// `solid` is a prefix of `rows`, so the indexes still line up.
					const points = solid.filter((_, index) => indexes.has(index))
					return [
						dot(points, {
							x: (row: TimeseriesRow) => row.date,
							y: (row: TimeseriesRow) => topOf(row, entry.key),
							r: 2.5,
							fill: entry.color,
						}),
					]
				}),
				...visible.map((entry) =>
					// `plotRows`, not `rows`: a focus dot over a bucket no band draws
					// is what kept the dropped in-flight slot on the axis and
					// hoverable.
					focusDot(
						plotRows,
						(row: TimeseriesRow) => row.date,
						// `topOf`, not the raw value: on a stack the active dot belongs on
						// the band's own top edge. Recharts arrived at the same place by
						// accident — its active dot was positioned from the stacked pixel
						// the layout had already computed.
						(row: TimeseriesRow) => topOf(row, entry.key),
						entry.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: timeseriesXAxis(axisContext),
			y: yAxis.y,
			focus: "group-x",
			// Recharts snapped to the nearest bucket anywhere in the plot; the
			// library stops looking 48px out, which blanks the tooltip, crosshair
			// and focus dot in the gaps of any chart with buckets more than ~96px
			// apart. See `UNBOUNDED_FOCUS_DISTANCE`.
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : cursorTooltip(focusStore.anchor),
		})
	}, [
		plotRows,
		visible,
		visibleKeys,
		baseOf,
		topOf,
		yAxis,
		gradientPrefix,
		dotIndexes,
		chromeColors,
		axisContext,
		focusStore,
		stacked,
		curveType,
		thresholds,
		tooltip,
	])

	return (
		<Timeseries.Provider model={model}>
			<Timeseries.Frame
				definition={definition}
				className={className}
				legend={legend}
				seriesStats={showStats}
				unit={unit}
				// `tooltipSeries`, not the model's: the card's row highlight is a
				// geometry question, and a stacked band's rows are not at their raw
				// values.
				tooltipSeries={tooltipSeries}
			/>
		</Timeseries.Provider>
	)
}
