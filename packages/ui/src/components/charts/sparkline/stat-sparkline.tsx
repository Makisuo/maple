import * as React from "react"

import { PlotSparkline } from "../../plot/sparkline"
import { validateCssColor } from "../../../lib/sanitizers"

interface StatSparklineProps {
	/** Timeseries rows; the first numeric field (other than `bucket`) is plotted. */
	data: ReadonlyArray<unknown>
	/** Stroke / fill color — a `var(--…)` token or literal color. */
	color?: string
	className?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/**
 * A minimal trend line for stat widgets — no axes, grid, legend, or tooltip.
 * Renders nothing when there are fewer than two plottable points.
 *
 * The drawing is `PlotSparkline`; what is left here is the part that is specific
 * to a stat widget — finding which column of an arbitrary timeseries row carries
 * the number.
 */
export function StatSparkline({ data, color = "var(--chart-1)", className }: StatSparklineProps) {
	const values = React.useMemo(() => {
		const rows = data.map(asRecord)
		if (rows.length === 0) return []

		let valueKey: string | null = null
		for (const row of rows) {
			if (!row) continue
			for (const [key, value] of Object.entries(row)) {
				if (key === "bucket") continue
				if (typeof value === "number" && Number.isFinite(value)) {
					valueKey = key
					break
				}
			}
			if (valueKey) break
		}
		if (!valueKey) return []

		return rows.map((row) => {
			const value = row?.[valueKey]
			return typeof value === "number" && Number.isFinite(value) ? value : 0
		})
	}, [data])

	const stroke = validateCssColor(color) ?? "var(--chart-1)"

	if (values.length < 2) return null

	return (
		<div className={className}>
			<PlotSparkline values={values} color={stroke} curve="monotone" className="h-full w-full" />
		</div>
	)
}
