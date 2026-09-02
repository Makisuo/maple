import { useMemo } from "react"
import { areaY, d3Curve, defineChart, dot, lineY, ruleX, stack, text } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { curveMonotoneX } from "d3-shape"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	resolvePlotColor,
	usePlotChromeColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { useTheme } from "@maple/ui/hooks/use-theme"

/** One stacked band segment: a day, the band it belongs to, and its dollars. */
interface SpendCell {
	point: CumulativePoint
	band: (typeof BANDS)[number]
	value: number | null
}

/**
 * What reaches the tooltip: a band segment when the stack is hovered, or a bare
 * day from the projection line.
 */
type SpendDatum = CumulativePoint | SpendCell

/** The day behind a datum — every band's cumulative total at that point. */
function dayOf(datum: SpendDatum): CumulativePoint {
	return typeof (datum as SpendCell).point === "object"
		? (datum as SpendCell).point
		: (datum as CumulativePoint)
}
import { ChartEmpty, ChartLoading } from "@maple/ui/components/charts"

import { formatCurrency } from "@/lib/billing/currency"
import {
	buildCumulativeSeries,
	type CumulativePoint,
	FEATURE_COLORS,
	FEATURE_SHORT_LABELS,
	SPEND_FEATURES,
	type SpendModel,
} from "@/lib/billing/spend"
import type { DailySpendResponse } from "@maple/domain/http"

/**
 * Cumulative spend for the cycle, stacked by what's driving it.
 *
 * Cumulative rather than daily on purpose: the question this chart answers is
 * "where will the bill land", and a daily bar chart makes the reader integrate in
 * their head. Per-day volume lives on the feature cards above.
 *
 * The base fee is a flat bottom band from day 1 — it's owed on day 1 — while the
 * dashed projection carries today's actual total to the end of the cycle.
 */

/** The plot itself. The states around it reserve {@link SPEND_CHART_HEIGHT}. */
const CHART_HEIGHT = 260

/**
 * The box the chart occupies including its legend strip, so the skeleton and the
 * empty state don't collapse the card while the cycle's spend loads.
 */
const SPEND_CHART_HEIGHT = 300

const chartConfig = {
	base: { label: "Base plan", color: "#57534a" },
	logs: { label: FEATURE_SHORT_LABELS.logs, color: FEATURE_COLORS.logs },
	traces: { label: FEATURE_SHORT_LABELS.traces, color: FEATURE_COLORS.traces },
	metrics: { label: FEATURE_SHORT_LABELS.metrics, color: FEATURE_COLORS.metrics },
	browser_sessions: {
		label: FEATURE_SHORT_LABELS.browser_sessions,
		color: FEATURE_COLORS.browser_sessions,
	},
	product_events: {
		label: FEATURE_SHORT_LABELS.product_events,
		color: FEATURE_COLORS.product_events,
	},
} satisfies Record<string, { label: string; color: string }>

const BANDS = ["base", ...SPEND_FEATURES] as const

export function SpendChartSkeleton() {
	return <ChartLoading variant="area" height={SPEND_CHART_HEIGHT} />
}

export function SpendChart({ model, daily }: { model: SpendModel; daily: DailySpendResponse | undefined }) {
	const data = useMemo(() => buildCumulativeSeries({ daily, model }), [daily, model])

	const projected = model.projectedCents / 100

	// The y-domain must contain both actual spend and the projection.
	const yMax = useMemo(() => {
		const peak = Math.max(projected, ...data.map((point) => point.total ?? 0), 1)
		return Math.ceil((peak * 1.1) / 10) * 10
	}, [data, projected])

	// Where "today" sits on an axis that now runs to the end of the cycle, and
	// where the projection lands.
	const todayPoint = useMemo(() => data.findLast((point) => !point.future), [data])

	// Cycle-to-date dollars per band, read off the last actual day — the legend
	// states what each color is worth so far.
	const bandTotals = useMemo(() => {
		const latest = data.findLast((point) => !point.future)
		return {
			base: latest?.base ?? 0,
			logs: latest?.logs ?? 0,
			traces: latest?.traces ?? 0,
			metrics: latest?.metrics ?? 0,
			browser_sessions: latest?.browser_sessions ?? 0,
			product_events: latest?.product_events ?? 0,
		} satisfies Record<(typeof BANDS)[number], number>
	}, [data])
	const lastPoint = data[data.length - 1]
	const hasFuture = lastPoint !== undefined && lastPoint.future

	if (data.length === 0) {
		return <ChartEmpty height={SPEND_CHART_HEIGHT}>No ingest recorded this cycle yet</ChartEmpty>
	}

	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { theme } = useTheme()
	// oxlint-disable-next-line react-hooks/exhaustive-deps
	const primary = useMemo(() => resolvePlotColor("--primary", "#6366f1"), [theme])

	const dateLabel = useMemo(
		() => (value: string) =>
			new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			}),
		[],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<SpendDatum>[]>(
		() =>
			BANDS.map((band) => ({
				label: chartConfig[band]?.label ?? band,
				color: chartConfig[band]?.color ?? chromeColors.border,
				// Read off the DAY, so a hovered band still prints every other band's
				// running total at that point rather than only its own.
				value: (datum: SpendDatum) => {
					const value = dayOf(datum)[band]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatCurrency(value, model.currency),
			})),
		[chromeColors.border, model.currency],
	)

	const definition = useMemo(() => {
		const at = (point: CumulativePoint) => point.date

		/**
		 * Stacking groups on `z`, so the bands are built as CELLS — one datum per
		 * band per day. Recharts stacked by matching `stackId` across five sibling
		 * `<Area>` elements instead.
		 */
		const cells: SpendCell[] = data.flatMap((point) =>
			BANDS.map((band) => ({
				point,
				band,
				value: typeof point[band] === "number" ? (point[band] as number) : null,
			})),
		)

		return defineChart({
			marks: [
				dashedGridY(),
				areaY(cells, {
					x: (cell: SpendCell) => cell.point.date,
					y: (cell: SpendCell) => cell.value,
					z: (cell: SpendCell) => cell.band,
					fill: (cell: SpendCell) => chartConfig[cell.band]?.color ?? chromeColors.border,
					fillOpacity: 0.35,
					stroke: (cell: SpendCell) => chartConfig[cell.band]?.color ?? chromeColors.border,
					strokeWidth: 1,
					curve: d3Curve(curveMonotoneX),
					layout: stack({ order: [...BANDS] }),
				}),
				// The projection: today's actual total joined to where the cycle
				// lands, dashed because it has not happened.
				...(hasFuture
					? [
							lineY(data, {
								id: "projected",
								x: at,
								y: (point: CumulativePoint) =>
									typeof point.projected === "number" ? point.projected : null,
								stroke: primary,
								strokeWidth: 1.5,
								strokeDasharray: "4 4",
							}),
						]
					: []),
				// The endpoint and its amount. `decorative` so neither takes focus
				// away from the bands, and neither widens the chart's point type.
				...(hasFuture && lastPoint
					? [
							decorative(
								dot([lastPoint], {
									x: at,
									y: () => projected,
									r: 3,
									fill: primary,
								}),
							),
							decorative(
								text([lastPoint], {
									x: at,
									y: () => projected,
									text: () => `${formatCurrency(projected, model.currency)} projected`,
									fill: primary,
									anchor: "end",
									dy: -8,
									fontSize: 10,
								}),
							),
						]
					: []),
				// "Today" — a vertical rule, which is what `ReferenceLine x=` was.
				...(todayPoint
					? [
							decorative(
								ruleX([todayPoint], {
									x: at,
									stroke: chromeColors.border,
									strokeOpacity: 1,
									strokeWidth: 1,
								}),
							),
						]
					: []),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: {
					scale: scalePoint,
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: dateLabel },
						tickLabels: { thin: { minGap: 12 } },
					},
				},
				y: {
					scale: scaleLinear().domain([0, yMax]),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							format: (value: number) => `$${Math.round(value)}`,
						},
					},
				},
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 8, right: 56, left: 52 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [
		data,
		hasFuture,
		lastPoint,
		todayPoint,
		projected,
		yMax,
		primary,
		chromeColors,
		dateLabel,
		model.currency,
		focusStore,
	])

	return (
		<div className="border border-border/60 bg-card/40">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-border/60 px-4 py-3">
				<div>
					<h3 className="text-sm">Spend this cycle</h3>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						Cumulative estimated spend by feature
					</p>
				</div>
				{/* The legend carries each band's cycle-to-date dollars, not just its
				    color: a row of six dots tells you which color is which, but not
				    which band is worth reading. With the amounts it doubles as the
				    breakdown, and the "$0.00" bands say plainly that they contribute
				    nothing rather than hiding somewhere on the axis. */}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
					{BANDS.map((band) => (
						<span key={band} className="inline-flex items-baseline gap-1.5">
							<span
								aria-hidden
								className="size-1.5 translate-y-[-1px] rounded-full"
								style={{ background: chartConfig[band]?.color }}
							/>
							<span className="text-[11px] text-muted-foreground">
								{chartConfig[band]?.label}
							</span>
							<span className="font-mono text-[11px] tabular-nums text-foreground/85">
								{formatCurrency(bandTotals[band], model.currency)}
							</span>
						</span>
					))}
				</div>
			</div>

			<div className="px-2 pb-2 pt-4">
				<div className="w-full" style={{ height: CHART_HEIGHT }}>
					<PlotFrame
						definition={definition}
						ariaLabel="Cumulative spend this cycle"
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(datum: SpendDatum) => dateLabel(dayOf(datum).date)}
							/>
						)}
					/>
				</div>
			</div>

			<div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
				<span>
					{model.cycleDays}-day cycle · day {model.dayOfCycle}
				</span>
				<span className="font-mono tabular-nums">
					projected {formatCurrency(projected, model.currency)}
				</span>
			</div>
		</div>
	)
}
