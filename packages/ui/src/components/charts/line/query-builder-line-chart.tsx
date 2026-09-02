import { d3Curve, defineChart, dot, lineY } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"
import * as React from "react"

import {
	Timeseries,
	asFiniteNumber,
	cursorTooltip,
	dashedGridY,
	findFirstPartialIndex,
	focusCrosshair,
	focusDot,
	roundCapDasharray,
	splitAtFirstPartial,
	thresholdRules,
	timeseriesXAxis,
	timeseriesYAxis,
	trimEmptyTrailingBuckets,
	useTimeseriesModel,
	type TimeseriesRow,
} from "../../plot"
import type { QueryBuilderLineChartProps } from "../_shared/chart-types"
import { isolatedPointIndexes, pointsFit } from "../_shared/sparse-series"

const STROKE_WIDTH = 2

export function QueryBuilderLineChart({
	data,
	className,
	legend,
	seriesStats: showStats,
	tooltip,
	curveType,
	unit,
	logScale,
	softMin,
	softMax,
	fitYAxisToData,
	showPoints,
	thresholds,
}: QueryBuilderLineChartProps) {
	const model = useTimeseriesModel({ data, unit })
	const { rows, visible, visibleKeys, chromeColors, axisContext, focusStore, containerWidth } = model

	/**
	 * The buckets this chart actually draws.
	 *
	 * A trailing in-flight bucket that reported nothing is dropped — see
	 * `trimEmptyTrailingBuckets`. Everything downstream has to agree on that, and
	 * that is the part that was missed here: the lines were built from the trimmed
	 * slices while the focus dots were still built over `rows`, and a mark's
	 * channels feed scale inference. So the x axis kept running out to a bucket
	 * nothing painted, and that phantom slot stayed hoverable with a zero-value
	 * tooltip past the end of the data. The area and bar siblings already do this.
	 */
	const plotRows = React.useMemo(() => {
		const first = findFirstPartialIndex(rows)
		return first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)
	}, [rows, visibleKeys])

	/** Which points carry a dot — every one, only the isolated ones, or none. */
	const dotIndexes = React.useMemo<ReadonlyMap<string, ReadonlySet<number>>>(() => {
		if (showPoints === false) return new Map()
		// Auto: dots on every point only when they fit the width, otherwise only on
		// the isolated points a line cannot show at all.
		if (showPoints === true || pointsFit(containerWidth, plotRows.length)) {
			const every = new Set(plotRows.map((_, index) => index))
			return new Map(visibleKeys.map((key) => [key, every]))
		}
		return isolatedPointIndexes(plotRows, visibleKeys)
	}, [showPoints, plotRows, containerWidth, visibleKeys])

	const definition = React.useMemo(() => {
		// The dashed tail is a SECOND mark over an overlapping slice, not a dash
		// pattern on the first: `strokeDasharray` on `lineY` is a scalar, not a
		// per-datum channel, so one mark cannot change style mid-line.
		const { solid, dashed } = splitAtFirstPartial(plotRows, visibleKeys)

		// `curve` takes a ChartCurve, not a string. Linear is the default shape, so
		// only monotone needs one built.
		const curve = curveType === "monotone" ? d3Curve(curveMonotoneX) : undefined
		// `lineY` hard-codes a round cap, which eats the gap — see `roundCapDasharray`.
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
		const line = (rowSlice: readonly TimeseriesRow[], entry: (typeof visible)[number], dash: boolean) =>
			lineY(rowSlice, {
				id: dash ? `${entry.key}-partial` : entry.key,
				x: (row: TimeseriesRow) => row.date,
				y: (row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
				stroke: entry.color,
				strokeWidth: STROKE_WIDTH,
				curve,
				strokeDasharray: dash ? partialDash : undefined,
			})

		return defineChart({
			marks: [
				dashedGridY(),
				// `labelX` anchors the label at the last bucket; without it
				// `thresholdRules` draws the rule and omits the text, which is how a
				// widget that names a threshold "SLO" ended up with an anonymous
				// dashed line indistinguishable from every other one. The label mark
				// is `decorative`, so it paints without emitting a hoverable datum
				// into the shared tooltip.
				...thresholdRules(thresholds ?? [], { labelX: plotRows.at(-1)?.date }),
				...visible.map((entry) => line(solid, entry, false)),
				...(dashed.length > 0 ? visible.map((entry) => line(dashed, entry, true)) : []),
				...visible.flatMap((entry) => {
					const indexes = dotIndexes.get(entry.key)
					if (!indexes || indexes.size === 0) return []
					// Dots cover the SOLID run only. Recharts got this for free — its
					// solid series was null across the in-flight region, so the dot
					// renderer never ran there — and it matters more than it looks: a
					// dashboard tile's partial tail is one bucket wide, so a dot at each
					// end fills the dashes in and the tail reads as a solid line.
					// `solid` is a prefix of `plotRows`, so the indexes still line up.
					const points = solid.filter((_, index) => indexes.has(index))
					return [
						dot(points, {
							x: (row: TimeseriesRow) => row.date,
							y: (row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
							r: 2.5,
							fill: entry.color,
						}),
					]
				}),
				...visible.map((entry) =>
					// `plotRows`, not `rows`: a focus dot over a bucket no line draws is
					// what kept the dropped in-flight slot on the axis and hoverable.
					focusDot(
						plotRows,
						(row: TimeseriesRow) => row.date,
						(row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
						entry.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: timeseriesXAxis(axisContext),
				y: timeseriesYAxis({
					rows: plotRows,
					visibleKeys,
					unit,
					logScale,
					softMin,
					softMax,
					fitYAxisToData,
					thresholds,
				}).y,
			},
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : cursorTooltip(focusStore.anchor),
		})
	}, [
		plotRows,
		visible,
		visibleKeys,
		dotIndexes,
		chromeColors,
		axisContext,
		focusStore,
		curveType,
		unit,
		logScale,
		softMin,
		softMax,
		fitYAxisToData,
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
			/>
		</Timeseries.Provider>
	)
}
