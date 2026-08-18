import { areaY, d3Curve, defineChart, lineY, stack } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { curveMonotoneX } from "d3-shape"
import { useMemo, type ReactNode } from "react"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	linearYDomain,
	niceLinearDomain,
	thresholdRules,
	useChartId,
	usePlotChromeColors,
	useResolvedSeriesColors,
	verticalGradient,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { ChartEmpty, useChartPlotHeight } from "@maple/ui/components/charts"
import { cn } from "@maple/ui/lib/utils"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import {
	CHART_EMPTY_MESSAGE,
	formatValueWithUnit,
	transformRows,
	UNNAMED_SERIES_KEY,
	type ChartUnit,
	type TransformedPoint,
} from "../chart-utils"
import { linkedCursorChartProps } from "@/hooks/use-linked-cursor"

/**
 * The utilization chart behind `/infra`'s host and Kubernetes detail pages.
 *
 * These were two files that had drifted into near-duplicates: same
 * `transformRows` pivot, same last-value header strip, same stacked-area-or-line
 * switch, same 80% threshold, same tooltip. What differed between them was
 * accidental — a 1.4px stroke against 1.6, a gradient ending at 0.04 against
 * 0.05, one y-axis 52px wide and the other unset. Sharing the component settles
 * those on one answer rather than preserving a difference nobody chose.
 */
export interface InfraMetricChartProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: ChartUnit
	/** Replaces the unnamed-series placeholder so a single line reads "CPU", not "value". */
	seriesLabel?: string
	/** Stacked bands (a resource split by container) rather than independent lines. */
	stacked?: boolean
	/** Draws the 80% warning rule. Percent units only — 80% of "cores" means nothing. */
	showThreshold?: boolean
	/** Joins the linked hover cursor. Omit to opt out. */
	linkedChartId?: string
	/**
	 * The last-value summary above the plot.
	 *
	 * A render prop, which is the one shape the composition rules bless: the
	 * header needs the pivoted series, their resolved colours and their latest
	 * values, and all three are computed in here from the long-form rows. The
	 * host page draws a plain right-aligned strip and the Kubernetes page draws
	 * bordered chips — a real difference, not drift, so neither is baked in.
	 */
	header?: (info: InfraSeriesInfo) => ReactNode
	waiting?: boolean
	height?: number
	className?: string
}

/**
 * One stacked band's datum: a bucket, the series it belongs to, and its value.
 *
 * Stacking groups on `z`, so a stacked chart plots CELLS while an unstacked one
 * plots the pivoted rows directly. Both reach the tooltip, which is why it reads
 * through `rowOf` rather than assuming one shape.
 */
interface InfraCell {
	point: TransformedPoint
	name: string
	value: number | null
}

type InfraDatum = TransformedPoint | InfraCell

/** What a header needs to describe the series it sits above. */
export interface InfraSeriesInfo {
	series: readonly string[]
	/** Resolved colour literals, keyed by series name. */
	colors: ReadonlyMap<string, string>
	/** The most recent value per series, absent when the series ended on a gap. */
	lastValues: Readonly<Record<string, number>>
	/** The display name — swaps the unnamed-series placeholder for the metric label. */
	labelFor: (name: string) => string
	unit: ChartUnit
}

/**
 * The pivoted row behind a datum — every series at that bucket.
 *
 * A structural `"point" in datum` check does NOT narrow here: `TransformedPoint`
 * carries an index signature, so every key is "in" it and `datum.point` comes
 * back as `string | number`. Probing the value's type is what actually
 * discriminates, since a row's values are never objects.
 */
function isCell(datum: InfraDatum): datum is InfraCell {
	return typeof (datum as InfraCell).point === "object"
}

function rowOf(datum: InfraDatum): TransformedPoint {
	return isCell(datum) ? datum.point : (datum as TransformedPoint)
}

/**
 * The plot height for every chart built on this primitive.
 *
 * Exported so a call site's loading/empty/error branches reserve the SAME box
 * (`<ChartPlotArea height={INFRA_METRIC_CHART_HEIGHT}>`) instead of repeating
 * the number as an `h-[220px]` literal that silently drifts from it.
 */
export const INFRA_METRIC_CHART_HEIGHT = 220
const STROKE_WIDTH = 1.5
const THRESHOLD_FRACTION = 0.8

export function InfraMetricChart({
	rows,
	unit,
	seriesLabel,
	stacked = false,
	showThreshold = false,
	linkedChartId,
	header,
	waiting = false,
	height,
	className,
}: InfraMetricChartProps) {
	// A surrounding `ChartPlotArea` has already reserved a box; matching it here
	// keeps the plot and the loading/empty/error branches it alternates with
	// exactly the same size. An explicit prop still wins. The hook is called
	// unconditionally — `height ?? useChartPlotHeight()` would skip it whenever a
	// prop was passed, which is a conditional hook.
	const inheritedHeight = useChartPlotHeight()
	const plotHeight = height ?? inheritedHeight ?? INFRA_METRIC_CHART_HEIGHT

	const chromeColors = usePlotChromeColors()
	const gradientPrefix = useChartId("infra")
	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const { data, series } = useMemo(() => transformRows(rows), [rows])

	/**
	 * Series names carry dots and slashes (container names, mount points), which
	 * is why they were never routed through `ChartContainer`'s `var(--color-…)`
	 * variables. They are resolved to literals here for a further reason: canvas
	 * cannot read a `var()` at all.
	 */
	const colorTokens = useMemo(() => resolveSeriesColors(series), [series])
	const colors = useResolvedSeriesColors(colorTokens, chromeColors.border)

	const labelFor = useMemo(
		() => (name: string) => (name === UNNAMED_SERIES_KEY ? (seriesLabel ?? name) : name),
		[seriesLabel],
	)

	const lastValues = useMemo(() => {
		const out: Record<string, number> = {}
		const latest = data[data.length - 1]
		if (!latest) return out
		for (const name of series) {
			const value = latest[name]
			if (typeof value === "number") out[name] = value
		}
		return out
	}, [data, series])

	const tickFormatter = useMemo(() => (value: number) => formatValueWithUnit(value, unit), [unit])

	/**
	 * One domain for the axis and the threshold alike.
	 *
	 * `thresholdRules` has no equivalent of Recharts' `ifOverflow="extendDomain"`,
	 * so the rule is fed to `linearYDomain` here — otherwise an 80% line over a
	 * chart peaking at 40% paints outside the plot, on top of the axis labels.
	 */
	const yDomain = useMemo<[number, number]>(() => {
		const thresholds = showThreshold && unit === "percent" ? [{ value: THRESHOLD_FRACTION }] : []
		return niceLinearDomain(linearYDomain({ rows: data, keys: series, stacked, thresholds }))
	}, [data, series, stacked, showThreshold, unit])

	const tooltipSeries = useMemo<PlotTooltipSeries<InfraDatum>[]>(
		() =>
			series.map((name) => ({
				label: labelFor(name),
				color: colors.get(name) ?? chromeColors.border,
				// Read off the pivoted ROW, so a stacked chart still prints every
				// series at the hovered bucket rather than only the band under the
				// cursor — the same reason the bar chart reads through `cell.row`.
				value: (datum: InfraDatum) => {
					const value = rowOf(datum)[name]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatValueWithUnit(value, unit),
			})),
		[series, labelFor, colors, chromeColors.border, unit],
	)

	const definition = useMemo(() => {
		const at = (point: TransformedPoint) => point.time
		const valueOf = (name: string) => (point: TransformedPoint) => {
			const value = point[name]
			return typeof value === "number" ? value : null
		}
		const colorOf = (name: string) => colors.get(name) ?? chromeColors.border
		const gradientFor = (name: string) => `${gradientPrefix}-${name.replace(/\W+/g, "_")}`
		const curve = d3Curve(curveMonotoneX)

		const thresholds =
			showThreshold && unit === "percent"
				? [{ value: THRESHOLD_FRACTION, color: "--severity-warn", label: "80%" }]
				: []

		/**
		 * Stacking is expressed over CELLS — one datum per series per bucket, with
		 * `z` naming the series — because `stack()` groups on `z`. Recharts stacked
		 * by matching `stackId` across sibling `<Area>` elements instead.
		 */
		const cells: InfraCell[] = stacked
			? data.flatMap((point) => series.map((name) => ({ point, name, value: valueOf(name)(point) })))
			: []

		const bands = stacked
			? [
					areaY(cells, {
						x: (cell: InfraCell) => cell.point.time,
						y: (cell: InfraCell) => cell.value,
						z: (cell: InfraCell) => cell.name,
						fill: (cell: InfraCell) => `url(#${gradientFor(cell.name)})`,
						stroke: (cell: InfraCell) => colorOf(cell.name),
						strokeWidth: STROKE_WIDTH,
						curve,
						layout: stack({ order: [...series] }),
					}),
				]
			: series.map((name) =>
					lineY(data, {
						id: name,
						x: at,
						y: valueOf(name),
						stroke: colorOf(name),
						strokeWidth: STROKE_WIDTH,
						curve,
					}),
				)

		return defineChart({
			gradients: stacked
				? series.map((name) => verticalGradient(gradientFor(name), colorOf(name), 0.45, 0.04))
				: [],
			marks: [
				dashedGridY(),
				...thresholdRules(thresholds, { labelX: data.at(-1)?.time }),
				...bands,
				...series.map((name) => focusDot(data, at, valueOf(name), colorOf(name), chromeColors)),
				focusCrosshair(chromeColors),
			],
			x: {
				// Categorical: these charts plot bucket LABELS, not timestamps.
				scale: scalePoint,
				axis: {
					line: false,
					ticks: { size: 0, padding: 8 },
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				scale: scaleLinear().domain(yDomain),
				axis: { line: false, ticks: { size: 0, padding: 8, format: tickFormatter } },
			},
			// A pinned left margin so sibling charts on the page share a plot edge.
			margin: { top: 12, right: 12, bottom: 0, left: 56 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [
		data,
		series,
		stacked,
		colors,
		chromeColors,
		gradientPrefix,
		yDomain,
		tickFormatter,
		showThreshold,
		unit,
		focusStore,
	])

	if (data.length === 0) {
		return <ChartEmpty height={height}>{CHART_EMPTY_MESSAGE}</ChartEmpty>
	}

	return (
		<div className={cn("transition-opacity", waiting && "opacity-60", className)}>
			{header?.({ series, colors, lastValues, labelFor, unit })}
			<div className="relative" {...linkedCursorChartProps(linkedChartId)}>
				<div style={{ height: plotHeight }}>
					<PlotFrame
						definition={definition}
						ariaLabel={seriesLabel ?? "Utilization"}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(datum: InfraDatum) => rowOf(datum).time}
							/>
						)}
					/>
				</div>
			</div>
		</div>
	)
}
