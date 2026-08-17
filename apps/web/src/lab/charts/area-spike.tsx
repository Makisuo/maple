import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, type ReactNode } from "react"

import {
	ChartSeriesLegend,
	useChartLegendState,
	type LegendSeriesSpec,
} from "@/lab/bench/tanstack/chart-legend"
import {
	createTooltipFocusProbe,
	focusCrosshair,
	focusDot,
	roundCapDasharray,
	TooltipBody,
	usePlotChromeColors,
	verticalGradient,
	type TooltipSeriesSpec,
} from "@/lab/bench/tanstack/chart-shared"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
import {
	errorThroughput,
	splitAtFirstPartial,
	timeseriesAxisContext,
	type TimeseriesSpikeRow,
} from "@/lab/charts/timeseries-data"

const AREA_TOKENS = {
	throughput: ["--chart-throughput", "#3b82f6"],
	error: ["--chart-error", "#ef4444"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * The faded fill production uses under a dashed tail
 * (`throughput-area-chart.tsx:138-145`): the same hue at a fraction of the
 * opacity, so the incomplete region reads as provisional without changing color.
 */
const FADED_START_OPACITY = 0.15
const FADED_END_OPACITY = 0

/**
 * Recharts and TanStack both nominally draw at 2px
 * (`query-builder-area-chart.tsx:383`), but the TanStack stroke reads visibly
 * thinner beside it. Matched by eye rather than by number.
 */
const STROKE_WIDTH = 2.5

/**
 * The trailing incomplete edge, matching `line-spike.tsx` — a visible 4.5 on,
 * 7 off. See the note there for why this is more open than production's 4/4, and
 * `roundCapDasharray` for why a literal `"4 4"` does not port.
 */
const INCOMPLETE_DASHARRAY = roundCapDasharray(4.5, 7, STROKE_WIDTH)

interface ThroughputSeries {
	id: string
	label: string
	color: string
	value: (row: TimeseriesSpikeRow) => number
}

/** Total volume and its error share, themed. Shared by both variants below. */
function useThroughputSeries(): readonly ThroughputSeries[] {
	const colors = usePlotColors(AREA_TOKENS)
	return useMemo(
		() => [
			{
				id: "throughput",
				label: "Throughput",
				color: colors.throughput,
				value: (row: TimeseriesSpikeRow) => row.throughput,
			},
			{
				id: "errors",
				label: "Errors",
				color: colors.error,
				value: errorThroughput,
			},
		],
		[colors],
	)
}

/**
 * The figure itself, over whatever series it is handed — see `line-spike.tsx`
 * for why the visible set arrives as a prop rather than being resolved here.
 */
function AreaFigure({
	rows,
	renderer,
	incomplete,
	className,
	series,
	idPrefix,
	legend,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete: boolean
	className?: string
	series: readonly ThroughputSeries[]
	idPrefix: string
	legend?: ReactNode
}) {
	const chromeColors = usePlotChromeColors()

	const axisContext = useMemo(() => timeseriesAxisContext(rows), [rows])

	const tooltipSeries = useMemo<TooltipSeriesSpec<TimeseriesSpikeRow>[]>(
		() =>
			series.map((s) => ({
				label: s.label,
				color: s.color,
				value: s.value,
				format: formatNumber,
			})),
		[series],
	)

	const { probe, anchor: tooltipAnchor } = useMemo(() => createTooltipFocusProbe<TimeseriesSpikeRow>(), [])

	const definition = useMemo(() => {
		const { solid, dashed } = incomplete
			? splitAtFirstPartial(rows)
			: { solid: rows, dashed: [] as readonly TimeseriesSpikeRow[] }

		// Over the VISIBLE series, so hiding Throughput rescales the axis to the
		// error band instead of leaving it flat against the floor. `|| 1` covers
		// every series hidden — `nice` has nothing to round on a `[0, 0]` domain.
		const dataMax =
			rows.reduce(
				(max, row) => series.reduce((seriesMax, s) => Math.max(seriesMax, s.value(row)), max),
				0,
			) || 1

		return defineChart({
			gradients: series.flatMap((s) => [
				verticalGradient(`${idPrefix}${s.id}`, s.color),
				verticalGradient(`${idPrefix}${s.id}Faded`, s.color, FADED_START_OPACITY, FADED_END_OPACITY),
			]),
			marks: [
				...series.flatMap((s) => [
					areaY(solid, {
						id: `${s.id}Area`,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: s.value,
						fill: `url(#${idPrefix}${s.id})`,
						stroke: "none",
					}),
					areaY(dashed, {
						id: `${s.id}AreaIncomplete`,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: s.value,
						fill: `url(#${idPrefix}${s.id}Faded)`,
						stroke: "none",
					}),
					lineY(solid, {
						id: `${s.id}Line`,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: s.value,
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
					}),
					lineY(dashed, {
						id: `${s.id}LineIncomplete`,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: s.value,
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
						strokeDasharray: INCOMPLETE_DASHARRAY,
					}),
				]),
				...series.map((s) =>
					focusDot(rows, (d: TimeseriesSpikeRow) => d.bucket, s.value, s.color, chromeColors),
				),
				focusCrosshair(chromeColors),
			],
			x: {
				// Pinned, not inferred: the solid and dashed marks each cover only part
				// of the domain (see `line-spike.tsx` for the same note).
				scale: scalePoint(
					rows.map((row) => row.bucket),
					[0, 1],
				),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						spacing: 72,
						format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
					},
				},
			},
			y: {
				scale: scaleLinear().domain([0, dataMax]),
				nice: true,
				grid: true,
				axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
			},
			focus: "group-x",
			focusRing: false,
			tooltip: {
				use: tooltip,
				className: "maple-bench-tooltip",
				anchor: tooltipAnchor,
				placement: "right",
				offset: 12,
			},
		})
	}, [rows, series, incomplete, idPrefix, axisContext, tooltipAnchor, chromeColors])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Request volume"
			definition={definition}
			legend={legend}
			renderTooltipBody={({ points }) => (
				<TooltipBody
					points={points}
					series={tooltipSeries}
					probe={probe}
					heading={(row: TimeseriesSpikeRow) =>
						`${formatBucketLabel(row.bucket, axisContext, "tooltip")}${row.partial ? " · partial" : ""}`
					}
				/>
			)}
		/>
	)
}

/**
 * Request volume, replacing
 * `packages/ui/src/components/charts/area/query-builder-area-chart.tsx`.
 *
 * Two compositional facts drive the mark list:
 *
 * 1. `areaY` strokes its WHOLE outline, baseline included, so a stroked area
 *    draws a line along y=0. Production composes a fill-only area with a separate
 *    `lineY` on top for exactly this reason, and so does this.
 * 2. `areaY` has no `strokeDasharray` at all (`dist/area.d.ts`), so the dashed
 *    tail cannot come from the area mark. It is a faded fill plus a dashed
 *    `lineY` edge — which is also what the Recharts arm does, since a dashed area
 *    outline is not expressible there either.
 */
export const AreaSpike = memo(function AreaSpike({
	rows,
	renderer,
	incomplete = false,
	className,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete?: boolean
	className?: string
}) {
	const series = useThroughputSeries()
	return (
		<AreaFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			series={series}
			// Gradient ids live in one document-wide namespace, and the gallery mounts
			// every arm at once. Suffixing by variant keeps `url(#…)` pointing at this
			// chart's own definition.
			idPrefix={incomplete ? "areaSpikeIncomplete" : "areaSpike"}
		/>
	)
})

/**
 * The same chart with a series key beneath it — the sibling-variant shape
 * `line-spike.tsx` explains.
 */
export const AreaLegendSpike = memo(function AreaLegendSpike({
	rows,
	renderer,
	incomplete = false,
	className,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete?: boolean
	className?: string
}) {
	const series = useThroughputSeries()

	const legendSeries = useMemo<LegendSeriesSpec[]>(
		() => series.map((s) => ({ key: s.id, label: s.label, color: s.color })),
		[series],
	)
	const { hidden, toggle } = useChartLegendState(legendSeries)

	const visibleSeries = useMemo(() => series.filter((s) => !hidden.has(s.id)), [series, hidden])

	return (
		<AreaFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			series={visibleSeries}
			// A third namespace: this arm renders beside both others in the gallery,
			// and two `<defs>` sharing an id is a silently wrong fill, not an error.
			idPrefix={incomplete ? "areaLegendSpikeIncomplete" : "areaLegendSpike"}
			legend={
				<ChartSeriesLegend
					series={legendSeries}
					hidden={hidden}
					onToggle={toggle}
					label="Request volume"
				/>
			}
		/>
	)
})
