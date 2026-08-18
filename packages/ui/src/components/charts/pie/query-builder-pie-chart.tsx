import { defineChart } from "@tanstack/charts"
import { focusGroupAngle, pie, polar, radialArc, radialText, type PieDatum } from "@tanstack/charts/polar"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import * as React from "react"

import { useContainerSize } from "../../../hooks/use-container-size"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { cn } from "../../../lib/utils"
import { muteColor } from "../../plot/color-scale"
import { PlotFrame, usePlotRect } from "../../plot/plot-frame"
import {
	MUTED_COLOR_AMOUNT,
	PlotSeriesLegend,
	PlotStatsLegend,
	usePlotLegendHighlight,
	type PlotLegendSeries,
} from "../../plot/plot-legend"
import { cursorTooltip } from "../../plot/plot-tooltip"
import { usePlotChromeColors, useResolvedSeriesColors } from "../../plot/theme"
import {
	bucketCategorical,
	MAX_CATEGORICAL,
	OTHER_COLOR,
	OTHER_LABEL,
	type CategoricalRow,
} from "../_shared/bucket-series"
import type { QueryBuilderPieChartProps } from "../_shared/chart-types"

/**
 * One category, ready to be sliced.
 *
 * A CLOSED type with no index signature, which is a requirement rather than a
 * style: `pie()` returns `Omit<TDatum, PieDerivedField> & …`, and `Omit` over a
 * type carrying an index signature resolves `keyof` to `string | number` and
 * drops every named field — `slice.name` would come back `unknown`. The same
 * rule is why every channel below is an accessor and not a `"startAngle"` field
 * name string.
 */
interface PieRow extends CategoricalRow {
	/** A RESOLVED literal — canvas cannot read a `var(--…)`. */
	color: string
}

type PieSlice = PieDatum<PieRow>

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

/**
 * Donut-centre total: exact counts under 10k read better than compact
 * notation ("1,500" instead of "1.5K"); larger totals stay compact.
 */
function fmtCenterTotal(value: number, unit?: string): string {
	if (!unit && Number.isInteger(value) && Math.abs(value) < 10_000) {
		return value.toLocaleString()
	}
	return fmtValue(value, unit)
}

function fmtPercent(fraction: number, digits = 1): string {
	return `${(fraction * 100).toFixed(fraction < 0.1 ? digits : 0)}%`
}

// Tabular legend: a share of the card, bounded so the pie never starves and the
// name column never runs away. Below TABLE_MIN_PIE_W of remaining width there
// is no pie worth drawing, so that layout falls back to the bottom chips.
//
// The minimum is set by the columns, not by taste: swatch + gaps + padding +
// the Value and Percent columns come to TABLE_FIXED_W, and anything narrower
// than that leaves the flex-1 name column at zero width — a legend of coloured
// squares and numbers with no labels, which is worse than the chips it replaced.
const TABLE_LEGEND_RATIO = 0.46
const TABLE_FIXED_W = 116
const TABLE_LEGEND_MIN_W = TABLE_FIXED_W + 52
const TABLE_LEGEND_MAX_W = 240
const TABLE_MIN_PIE_W = 120

// Slices below this fraction do not get an in-slice label — the wedge is too
// narrow to host text without overflowing onto its neighbours.
const LABEL_MIN_FRACTION = 0.06

/**
 * Where an in-slice label sits, as a position on the radius scale below —
 * which is ranged from the donut hole to the outer edge, so 0.5 is the middle
 * of the ring whatever the hole's size. A full pie has no hole, so its scale
 * starts at the centre and the label rides at 0.62 to stay off the apex.
 */
const LABEL_RADIUS_DONUT = 0.5
const LABEL_RADIUS_PIE = 0.62

/** How much the hovered slice grows, and how far the rest fade. */
const HOVER_GROWTH = 1.035
const REST_OPACITY = 0.55

/**
 * Room for the hovered slice to grow into. `HOVER_GROWTH` of a ~190px radius is
 * ~7px, so 8px of inset covers it — the arc is clipped at the plot edge
 * otherwise, and a clipped "grown" slice reads as a rendering bug rather than an
 * affordance.
 */
const PLOT_INSET = 8

/** The gap between neighbouring slices, painted in the card's own background. */
const SLICE_STROKE_WIDTH = 1.5

/** Below this hole radius the centre total has nowhere to sit without spilling. */
const CENTER_TOTAL_MIN_INNER_R = 18

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

/**
 * The donut hole, in pixels, for a given outer radius.
 *
 * Shared by the arc mark, the radius scale the labels ride on, and the React
 * side's decision about whether the centre total fits — three readings of one
 * number that must not drift. `innerRadius` is the caller's override, clamped so
 * it can neither collapse the hole nor eat the ring.
 */
function resolveInnerRadius(outerRadius: number, donut: boolean, innerRadius: number | undefined): number {
	if (!donut) return 0
	return Math.max(8, Math.min(outerRadius - 6, innerRadius ?? outerRadius * 0.58))
}

/**
 * The donut's centre total, as DOM in the frame's overlay layer.
 *
 * DOM rather than a mark, and that is a decision rather than an oversight: a
 * `radialText` at radius zero would push a focus point into the middle of the
 * hole, so hovering the empty centre of a donut would open a tooltip for a datum
 * that is not a slice — `focusGroupAngle` resolves an angle happily whether or
 * not the pointer is over a wedge. The overlay layer is `pointer-events-none`
 * and nothing here opts back in, so the hole stays untargetable.
 *
 * Positioned off `usePlotRect()` rather than off the layer's own box: the rect is
 * the region the scene actually painted the polar chart into, so the total is
 * pinned to the same centre the arcs were struck from even if the frame ever
 * stops handing the whole box to a polar plot.
 */
function DonutCenterTotal({
	total,
	unit,
	innerRadius,
}: {
	total: number
	unit: string | undefined
	innerRadius: number | undefined
}) {
	const rect = usePlotRect()
	if (rect === null) return null

	// The same arithmetic the arc mark runs, against the same inset, so the total
	// appears exactly when there is a hole big enough to hold it.
	const plotRadius = Math.min(rect.width, rect.height) / 2 - PLOT_INSET
	const holeRadius = resolveInnerRadius(plotRadius, true, innerRadius)
	if (holeRadius <= CENTER_TOTAL_MIN_INNER_R) return null

	return (
		<div
			className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center leading-none"
			style={{ left: rect.x + rect.width / 2, top: rect.y + rect.height / 2 }}
		>
			<span
				className="font-semibold text-foreground tabular-nums"
				style={{ fontSize: Math.min(22, holeRadius * 0.6), letterSpacing: "-0.02em" }}
			>
				{fmtCenterTotal(total, unit)}
			</span>
			<span
				className="pt-1 text-muted-foreground uppercase"
				style={{ fontSize: Math.min(10, holeRadius * 0.28), letterSpacing: "0.04em" }}
			>
				total
			</span>
		</div>
	)
}

export function QueryBuilderPieChart({
	data,
	className,
	legend,
	tooltip,
	unit,
	donut,
	innerRadius,
	showLabels = false,
	showPercent = true,
}: QueryBuilderPieChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const { rows, colorTokens, total } = React.useMemo(() => {
		const parsed: CategoricalRow[] = source
			.map((row) => {
				const raw = row.name == null ? "" : String(row.name).trim()
				return {
					name: raw === "" ? "(no value)" : raw,
					value: asFiniteNumber(row[valueField]),
				}
			})
			// Zero/negative rows render as invisible arcs but still occupy
			// legend rows — drop them.
			.filter((row) => row.value > 0)
		// Collapse the long tail of small categories into a single "Other" slice
		// (also sorts largest-first). Keeps both the pie and its legend legible
		// when a group-by produces dozens of categories.
		const bucketed = bucketCategorical(parsed, MAX_CATEGORICAL)
		const sum = bucketed.reduce((acc, row) => acc + row.value, 0)
		// Resolved by name, so a slice keeps its colour even though
		// `bucketCategorical` re-sorts largest-first. "Other" is a bucket, not an
		// identity, so it takes the neutral token instead of an identity hue.
		const byName = resolveSeriesColors(
			bucketed.map((row) => row.name).filter((name) => name !== OTHER_LABEL),
		)
		return {
			rows: bucketed,
			colorTokens: new Map(
				bucketed.map((row) => [
					row.name,
					row.name === OTHER_LABEL ? OTHER_COLOR : (byName.get(row.name) ?? OTHER_COLOR),
				]),
			),
			total: sum,
		}
	}, [source, valueField])

	// `resolveSeriesColors` hands back `var(--chart-3)` and friends, which paint
	// on SVG and resolve to NOTHING on canvas — PlotFrame's dev assertion throws
	// on one that slips through.
	const colors = useResolvedSeriesColors(colorTokens, "#a1a1aa")
	const chrome = usePlotChromeColors()

	const pieRows = React.useMemo<PieRow[]>(
		() => rows.map((row) => ({ ...row, color: colors.get(row.name) ?? "#a1a1aa" })),
		[rows, colors],
	)

	/**
	 * The hovered slice, from EITHER side: pointing at an arc lights its legend
	 * row and pointing at a legend row grows its slice, off one piece of state.
	 * The Recharts chart ran one `hover` index through both for the same reason.
	 */
	const [activeName, setActiveName] = React.useState<string | null>(null)
	// Clicking a legend row PINS an emphasis, muting the other slices until it is
	// clicked again. Nothing is ever removed: `pie()` divides by the total of the
	// rows it is handed, so dropping one would renormalise every remaining angle
	// and rearrange the whole donut around the slice the reader just picked.
	const { highlighted, highlight } = usePlotLegendHighlight()

	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const containerSize = useContainerSize(containerRef)

	// A composition breakdown is read as a ranked table, not as a colour-matching
	// exercise: `legend: "right"` puts the slices in a sorted Value/% key beside
	// the pie. "visible" keeps the compact bottom chips for cards too narrow to
	// host a table. Below TABLE_MIN_PIE_W of leftover width the table would starve
	// the pie, so it degrades to chips rather than rendering both badly.
	const showLegend = legend !== "hidden"
	const tableLegendW = clamp(
		Math.round(containerSize.width * TABLE_LEGEND_RATIO),
		TABLE_LEGEND_MIN_W,
		TABLE_LEGEND_MAX_W,
	)
	const tableLegend =
		showLegend && legend === "right" && containerSize.width - tableLegendW >= TABLE_MIN_PIE_W
	const chipLegend = showLegend && !tableLegend

	const legendSeries = React.useMemo<PlotLegendSeries[]>(
		() =>
			pieRows.map((row) => {
				const entry: PlotLegendSeries = {
					key: row.name,
					// The collapsed count rides on the label so the reader can tell how
					// much the "Other" bucket is hiding rather than assuming the chart
					// is everything.
					label: row.collapsedCount ? `${row.name} +${row.collapsedCount}` : row.name,
					color: row.color,
				}
				// Figures only in the side layout: the bottom chips are a colour key,
				// and a row of numbers wrapped across two lines reads as neither.
				// Formatted HERE, not in the legend: the legend has no idea whether
				// this column is a span count or a latency.
				if (tableLegend) {
					entry.value = fmtValue(row.value, unit)
					entry.secondary = total > 0 ? fmtPercent(row.value / total, 1) : "—"
				}
				return entry
			}),
		[pieRows, tableLegend, unit, total],
	)

	const definition = React.useMemo(() => {
		// `pie()` is an EAGER transform, not a mark: it returns rows carrying
		// startAngle/endAngle/angle/fraction, which `radialArc` then reads as plain
		// channels.
		const slices = pie(pieRows, { value: (row: PieRow) => row.value })

		// Split AFTER `pie()`, never before: the transform is what assigns the
		// angles, so slicing its OUTPUT keeps every wedge exactly where it was.
		// Splitting the rows first would renormalise the whole donut.
		const active = activeName === null ? [] : slices.filter((slice) => slice.name === activeName)
		const rest = activeName === null ? slices : slices.filter((slice) => slice.name !== activeName)

		// Emphasis is a COLOUR, not an opacity: `fillOpacity` is a flat per-mark
		// number on every polar mark, so a single arc mark covering every slice has
		// no way to dim one datum and not another.
		const fillFor = (slice: PieSlice) =>
			highlighted === null || slice.name === highlighted
				? slice.color
				: muteColor(slice.color, chrome.background, MUTED_COLOR_AMOUNT)

		const innerRadiusFor = (context: { radius: number }) =>
			resolveInnerRadius(context.radius, donut === true, innerRadius)

		const arcOptions = {
			startAngle: (slice: PieSlice) => slice.startAngle,
			endAngle: (slice: PieSlice) => slice.endAngle,
			innerRadius: innerRadiusFor,
			fill: fillFor,
			// The seam between neighbouring wedges, painted in the card's own
			// background so it reads as a gap rather than as a border.
			stroke: chrome.background,
			strokeWidth: SLICE_STROKE_WIDTH,
		}

		return defineChart({
			marks: [
				polar({
					radiusRatio: 1,
					inset: PLOT_INSET,
					/**
					 * Both scales exist for the LABEL mark alone — `radialArc` reads raw
					 * angles and pixel radii and declares neither.
					 *
					 * Pinned domains, and pinned for different reasons. The angle scale is
					 * ranged over the polar span (0…2π), so a domain of the same numbers
					 * makes it the identity and a label can be positioned in the radians
					 * `pie()` already computed. The radius scale is ranged from the donut
					 * hole to the outer edge, so a 0…1 domain turns "how far across the
					 * ring" into a single number that means the same thing on a pie and on
					 * a donut of any hole size.
					 *
					 * Fresh instances per definition, never module scope: the layout
					 * resolver calls `scale.range()` on whatever it is handed, so a shared
					 * instance would carry one chart's pixel range into the next.
					 */
					angle: { scale: scaleLinear().domain([0, Math.PI * 2]) },
					radius: {
						scale: scaleLinear().domain([0, 1]),
						range: [innerRadiusFor, (context) => context.radius],
					},
					marks: [
						/**
						 * TWO arc marks, not one, and that is the whole hover affordance:
						 * `outerRadius` and `fillOpacity` are per-MARK (a `PolarLength` and
						 * a flat number), never per-datum, so the only way to give one slice
						 * its own radius is to give it its own mark over a one-element slice
						 * of the same transformed data. Polar marks take no `states`, so
						 * there is no in-definition route to a hover style at all.
						 */
						radialArc(rest, {
							...arcOptions,
							outerRadius: (context) => context.radius,
							fillOpacity: activeName === null ? undefined : REST_OPACITY,
						}),
						radialArc(active, {
							...arcOptions,
							outerRadius: (context) => context.radius * HOVER_GROWTH,
						}),
						...(showLabels
							? [
									radialText(slices, {
										angle: (slice: PieSlice) => slice.angle,
										// `null` skips the label AND its focus point, which is
										// how a wedge too narrow to host text opts out without
										// leaving an invisible target behind.
										radius: (slice: PieSlice) =>
											slice.fraction < LABEL_MIN_FRACTION
												? null
												: donut
													? LABEL_RADIUS_DONUT
													: LABEL_RADIUS_PIE,
										text: (slice: PieSlice) =>
											showPercent
												? fmtPercent(slice.fraction, 1)
												: fmtValue(slice.value, unit),
										// White on the wedge, as before. The Recharts-era chart
										// also carried a dark paint-order stroke behind it;
										// `radialText` has no stroke, so a label over a pale
										// slice leans on the palette's contrast instead.
										fill: "#ffffff",
										fontSize: 11,
										fontWeight: 600,
									}),
								]
							: []),
					],
				}),
			],
			// No x/y axes exist in a polar chart; passing null keeps the cartesian
			// guides off rather than letting them infer an empty domain.
			x: null,
			y: null,
			// Cartesian `focus: "nearest"` does not engage on polar marks at all — no
			// tooltip, no focus state, no error. `focusGroupAngle` is the polar
			// strategy. It groups by angle, so a slice's label and its arc resolve to
			// the same datum and the tooltip reads the same slice either way.
			focus: focusGroupAngle,
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : cursorTooltip<PieSlice>("pointer"),
		})
	}, [pieRows, activeName, highlighted, chrome, donut, innerRadius, showLabels, showPercent, unit, tooltip])

	if (rows.length === 0 || total <= 0) {
		return (
			<div
				ref={containerRef}
				className={cn("relative grid h-full w-full place-items-center", className)}
			>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	const seriesLegend = (
		<PlotSeriesLegend
			series={legendSeries}
			highlighted={highlighted}
			onHighlight={highlight}
			active={activeName}
			onActiveChange={setActiveName}
			label="Share by category"
		/>
	)

	/**
	 * The TABLE legend is composed here rather than handed to `PlotFrame.legend`,
	 * because the frame's slot stacks below the plot and this form sits beside it.
	 * The chip form goes through the slot, where the frame re-measures itself: it
	 * observes its own inner box, so a strip that rewraps to a second row shrinks
	 * the plot with no arithmetic here.
	 */
	return (
		<div
			ref={containerRef}
			className={cn(
				"flex h-full w-full select-none",
				tableLegend ? "flex-row items-stretch gap-3" : "flex-col",
				className,
			)}
		>
			<PlotFrame
				className="min-h-0 min-w-0 flex-1"
				ariaLabel="Share by category"
				definition={definition}
				// EDGE-triggered, which is the only reason rebuilding the definition
				// on hover is affordable: it fires when the focused datum changes, not
				// on every pointer move, so crossing five slices costs five commits
				// rather than one per pixel.
				onFocusChange={(point) => setActiveName(point?.datum.name ?? null)}
				legend={chipLegend ? seriesLegend : undefined}
				overlay={
					donut === true ? (
						<DonutCenterTotal total={total} unit={unit} innerRadius={innerRadius} />
					) : undefined
				}
				// Mandatory, not cosmetic: the default body prints the mark's x/y
				// channels, which for a polar mark are the angle in radians and the
				// radius in pixels ("x 1.336 / y 113.76").
				renderTooltipBody={({ points }) => {
					const slice = points[0]?.datum
					if (!slice) return null
					return (
						<div className="whitespace-nowrap text-[11px]">
							<div className="flex items-center gap-1.5 font-medium text-foreground">
								<span
									className="size-2 rounded-[2px]"
									style={{ backgroundColor: slice.color }}
								/>
								<span>{slice.name}</span>
								{slice.collapsedCount ? (
									<span className="font-normal text-muted-foreground">
										({slice.collapsedCount} categories)
									</span>
								) : null}
							</div>
							<div className="mt-0.5 text-muted-foreground tabular-nums">
								<span className="text-foreground/90">{fmtValue(slice.value, unit)}</span>
								<span className="px-1 text-muted-foreground/60">·</span>
								<span>{(slice.fraction * 100).toFixed(1)}%</span>
							</div>
						</div>
					)
				}}
			/>
			{tableLegend ? (
				<div className="shrink-0 overflow-y-auto" style={{ width: tableLegendW }}>
					<PlotStatsLegend
						series={legendSeries}
						highlighted={highlighted}
						onHighlight={highlight}
						active={activeName}
						onActiveChange={setActiveName}
						label="Share by category"
					/>
				</div>
			) : null}
		</div>
	)
}

function clamp(value: number, lo: number, hi: number): number {
	if (!Number.isFinite(value)) return lo
	return Math.max(lo, Math.min(hi, value))
}
