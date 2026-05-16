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
			count === 0
				? { min: 0, max: 0, mean: 0, last: 0 }
				: { min, max, mean: sum / count, last }
	}

	return result
}

interface QueryBuilderLegendProps {
	series: ReadonlyArray<LegendSeries>
	stats: Record<string, SeriesStats>
	hidden: ReadonlySet<string>
	onToggle: (key: string) => void
	unit?: string
	layout?: "bottom" | "right"
}

const STAT_COLUMNS: ReadonlyArray<{ label: string; field: keyof SeriesStats }> = [
	{ label: "Min", field: "min" },
	{ label: "Max", field: "max" },
	{ label: "Mean", field: "mean" },
	{ label: "Last", field: "last" },
]

/**
 * Interactive chart legend rendered inside a Recharts `<Legend content>` slot.
 * Shows per-series Min/Max/Mean/Last and toggles a series on click.
 */
export function QueryBuilderLegend({
	series,
	stats,
	hidden,
	onToggle,
	unit,
	layout = "bottom",
}: QueryBuilderLegendProps) {
	if (series.length === 0) return null

	return (
		<div
			className={cn(
				"h-full overflow-auto text-xs",
				layout === "right" ? "pl-3" : "pt-2",
			)}
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
										<span className="truncate">{entry.label}</span>
									</span>
								</td>
								{STAT_COLUMNS.map((column) => (
									<td
										key={column.field}
										className="px-2 text-right font-mono tabular-nums last:pr-0"
									>
										{entryStats
											? formatValueByUnit(entryStats[column.field], unit)
											: "—"}
									</td>
								))}
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}
