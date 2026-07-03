import { cn } from "../../../lib/utils"
import { formatValueByUnit } from "../../../lib/format"

export interface LegendSeries {
	/** Internal chart key (s1, s2, …). */
	key: string
	/** Human-readable series name. */
	label: string
	/** Resolved CSS color (a `var(--…)` token or literal color). */
	color: string
}

export interface SeriesStats {
	min: number
	max: number
	mean: number
	last: number
}

/** Computes Min/Max/Mean/Last for each series key across the chart's rows. */
export function computeSeriesStats(
	data: ReadonlyArray<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): Record<string, SeriesStats> {
	const result: Record<string, SeriesStats> = {}

	for (const key of keys) {
		let min = Number.POSITIVE_INFINITY
		let max = Number.NEGATIVE_INFINITY
		let sum = 0
		let count = 0
		let last = 0

		for (const row of data) {
			const value = row[key]
			if (typeof value !== "number" || !Number.isFinite(value)) continue
			if (value < min) min = value
			if (value > max) max = value
			sum += value
			count += 1
			last = value
		}

		result[key] =
			count === 0 ? { min: 0, max: 0, mean: 0, last: 0 } : { min, max, mean: sum / count, last }
	}

	return result
}

function isAllZeroStats(stats: SeriesStats | undefined): boolean {
	return stats != null && stats.min === 0 && stats.max === 0 && stats.mean === 0 && stats.last === 0
}

/**
 * Stable sort that pushes all-zero series to the bottom of the legend, so
 * series with actual data aren't buried under rows of zeros (MAP-49).
 */
export function sortZeroSeriesLast(
	series: ReadonlyArray<LegendSeries>,
	stats: Record<string, SeriesStats>,
): LegendSeries[] {
	return [...series].sort(
		(a, b) => Number(isAllZeroStats(stats[a.key])) - Number(isAllZeroStats(stats[b.key])),
	)
}

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
 * Interactive chart legend rendered inside a Recharts `<Legend content>` slot.
 * `variant="compact"` is a lightweight color key; `variant="stats"` adds the
 * per-series Min/Max/Mean/Last table. Clicking a series toggles it.
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

	const maxHeightStyle = maxHeight != null ? { maxHeight } : undefined

	if (variant === "compact") {
		return (
			<div
				style={maxHeightStyle}
				className={cn(
					"h-full overflow-auto text-xs",
					layout === "right"
						? "flex flex-col gap-0.5 pl-3"
						: "flex flex-wrap gap-x-3 gap-y-0.5 pt-2",
				)}
			>
				{series.map((entry) => {
					const isHidden = hidden.has(entry.key)
					return (
						<button
							key={entry.key}
							type="button"
							onClick={() => onToggle(entry.key)}
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

	return (
		<div
			style={maxHeightStyle}
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
					{series.map((entry) => {
						const entryStats = stats[entry.key]
						const isHidden = hidden.has(entry.key)
						const allZero = isAllZeroStats(entryStats)
						return (
							<tr
								key={entry.key}
								onClick={() => onToggle(entry.key)}
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
