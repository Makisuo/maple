import { cn } from "../../../lib/utils"
import { formatValueByUnit } from "../../../lib/format"
import { isAllZeroStats, type SeriesStats, type StatsSeries } from "../../plot/series-stats"
import { PlotLegend, usePlotLegend } from "../../plot/plot-legend"

/**
 * A series row, as the legend draws it.
 *
 * An alias rather than a second declaration: `StatsSeries` is the same
 * `{ key, label, color }` triple, and keeping two of them is what let the stats
 * helpers below drift from their counterparts in `plot/series-stats.ts` — same
 * names, opposite handling of a missing entry.
 */
export type LegendSeries = StatsSeries

interface QueryBuilderLegendProps {
	series: ReadonlyArray<LegendSeries>
	stats: Record<string, SeriesStats>
	hidden: ReadonlySet<string>
	onToggle: (key: string) => void
	unit?: string
	layout?: "bottom" | "right"
	/**
	 * `"compact"` shows only the color swatch + label; `"stats"` adds the
	 * per-series Min/Max/Mean/Last columns.
	 */
	variant?: "compact" | "stats"
	/**
	 * Upper bound (px) on the legend's own height. A right-aligned legend isn't
	 * height-constrained by Recharts, so a long series list would overflow the
	 * card; capping it here lets the `overflow-auto` body scroll instead.
	 */
	maxHeight?: number
}

/** Vertical space (px) a bottom-aligned legend block needs. */
export function legendBlockHeight(variant: "compact" | "stats", seriesCount: number): number {
	if (variant === "stats") {
		// pt-2 (8) + header row (20) + capped data rows (20 each)
		return 28 + Math.min(seriesCount, 4) * 20
	}
	// pt-2 (8) + wrapped 20px rows + 2px gap-y between rows
	const rows = Math.ceil(Math.min(seriesCount, 12) / 3)
	return 6 + rows * 22
}

const MIN_CHART_PLOT_HEIGHT = 100 // keep plot + x-axis readable
const MAX_LEGEND_FRACTION = 0.45 // stats table never exceeds ~45% of the widget
const MIN_LEGEND_HEIGHT = 44 // header row + partial scrollable row

/**
 * Like {@link legendBlockHeight}, but caps the reservation to the measured
 * container height so the chart keeps a usable plot height in short widgets.
 * The legend body (`h-full overflow-auto`) scrolls inside the capped strip.
 */
export function responsiveLegendHeight(
	variant: "compact" | "stats",
	seriesCount: number,
	containerHeight: number | undefined,
): number {
	const ideal = legendBlockHeight(variant, seriesCount)
	if (!containerHeight || containerHeight <= 0) return ideal // pre-measure: avoid flash
	const cap = Math.min(
		Math.round(containerHeight * MAX_LEGEND_FRACTION),
		containerHeight - MIN_CHART_PLOT_HEIGHT,
	)
	if (cap < MIN_LEGEND_HEIGHT) {
		// Widget too short to honor both — give the legend a small scrollable strip.
		return Math.min(MIN_LEGEND_HEIGHT, Math.round(containerHeight * MAX_LEGEND_FRACTION))
	}
	return Math.max(MIN_LEGEND_HEIGHT, Math.min(ideal, cap))
}

const STAT_COLUMNS: ReadonlyArray<{ label: string; field: keyof SeriesStats }> = [
	{ label: "Min", field: "min" },
	{ label: "Max", field: "max" },
	{ label: "Mean", field: "mean" },
	{ label: "Last", field: "last" },
]

/**
 * The interactive legend the query-builder time-series charts draw.
 *
 * The MARKUP here is this component's own — a wrapped strip of buttons, or a
 * four-column stats table — and deliberately not `PlotLegend`'s items. The two
 * legends serve different interaction models: this one HIDES a series, which
 * rescales the axis under the reader, while `PlotLegend` pins one and mutes the
 * rest. Their rows say different things and look different, and collapsing them
 * would have meant changing what every dashboard tile renders.
 *
 * What IS shared is the state pipeline. Both now hang off one
 * `PlotLegend.Provider`, so the series list, the hidden set and the toggle have
 * a single shape and a single context — rather than two components each
 * receiving their own copy by prop and drifting, which is how their stats
 * helpers ended up with opposite handling of a missing entry.
 */
export function QueryBuilderLegend({
	series,
	stats,
	hidden,
	onToggle,
	unit,
	layout = "bottom",
	variant = "stats",
	maxHeight,
}: QueryBuilderLegendProps) {
	if (series.length === 0) return null
	return (
		// No `highlighted`/`onHighlight`: supplying `onToggle` alone is what picks
		// the hiding mode.
		<PlotLegend.Provider series={series} hidden={hidden} onToggle={onToggle} label="Chart legend">
			{variant === "compact" ? (
				<CompactStrip layout={layout} maxHeight={maxHeight} />
			) : (
				<StatsTable layout={layout} maxHeight={maxHeight} stats={stats} unit={unit} />
			)}
		</PlotLegend.Provider>
	)
}

/** `maxHeight` as a style, or nothing — see the prop's note. */
function heightStyle(maxHeight: number | undefined) {
	return maxHeight != null ? { maxHeight } : undefined
}

/** The colour key: swatch and label per series, wrapped. */
function CompactStrip({ layout, maxHeight }: { layout: "bottom" | "right"; maxHeight?: number }) {
	const { state, actions } = usePlotLegend()
	return (
		<div
			style={heightStyle(maxHeight)}
			className={cn(
				"h-full overflow-auto text-xs",
				layout === "right" ? "flex flex-col gap-0.5 pl-3" : "flex flex-wrap gap-x-3 gap-y-0.5 pt-2",
			)}
		>
			{state.series.map((entry) => {
				const isHidden = state.hidden.has(entry.key)
				return (
					<button
						key={entry.key}
						type="button"
						onClick={() => actions.toggle?.(entry.key)}
						className={cn(
							"hover:bg-muted/50 flex items-center gap-1.5 rounded px-1 py-0.5 select-none",
							isHidden && "opacity-40",
						)}
					>
						<span
							className="size-2 shrink-0 rounded-[2px]"
							style={{ backgroundColor: entry.color }}
						/>
						<span className="truncate">{entry.label}</span>
					</button>
				)
			})}
		</div>
	)
}

/** The colour key plus the per-series Min/Max/Mean/Last columns. */
function StatsTable({
	layout,
	maxHeight,
	stats,
	unit,
}: {
	layout: "bottom" | "right"
	maxHeight?: number
	// `stats` and `unit` stay PROPS rather than joining the context: they are what
	// this table renders and how it formats, not state the legend shares with the
	// chart. Putting query-builder figures into the generic legend context would
	// be the first field that only one consumer can ever set.
	stats: Record<string, SeriesStats>
	unit?: string
}) {
	const { state, actions } = usePlotLegend()
	return (
		<div
			style={heightStyle(maxHeight)}
			className={cn("h-full overflow-auto text-xs", layout === "right" ? "pl-3" : "pt-2")}
		>
			<table className="w-full border-collapse">
				<thead>
					<tr className="text-muted-foreground">
						<th className="py-0.5 pr-3 text-left font-normal">Series</th>
						{STAT_COLUMNS.map((column) => (
							<th key={column.field} className="px-2 text-right font-normal last:pr-0">
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{state.series.map((entry) => {
						const entryStats = stats[entry.key]
						const isHidden = state.hidden.has(entry.key)
						const allZero = isAllZeroStats(entryStats)
						return (
							<tr
								key={entry.key}
								onClick={() => actions.toggle?.(entry.key)}
								className={cn(
									"hover:bg-muted/50 cursor-pointer select-none",
									isHidden && "opacity-40",
								)}
							>
								<td className="py-0.5 pr-3">
									<span className="flex items-center gap-1.5">
										<span
											className="size-2 shrink-0 rounded-[2px]"
											style={{ backgroundColor: entry.color }}
										/>
										<span className={cn("truncate", allZero && "text-muted-foreground")}>
											{entry.label}
										</span>
									</span>
								</td>
								{allZero ? (
									// Four zeros in a row read as noise — collapse to one muted 0.
									<td
										colSpan={STAT_COLUMNS.length}
										className="px-2 text-right font-mono tabular-nums text-muted-foreground/60"
									>
										0
									</td>
								) : (
									STAT_COLUMNS.map((column) => (
										<td
											key={column.field}
											className="px-2 text-right font-mono tabular-nums last:pr-0"
										>
											{entryStats
												? formatValueByUnit(entryStats[column.field], unit)
												: "—"}
										</td>
									))
								)}
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}
