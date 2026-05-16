import * as React from "react"
import { Area, AreaChart, ResponsiveContainer } from "recharts"

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
 */
export function StatSparkline({ data, color = "var(--chart-1)", className }: StatSparklineProps) {
	const points = React.useMemo(() => {
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
			return { v: typeof value === "number" && Number.isFinite(value) ? value : 0 }
		})
	}, [data])

	const gradientId = React.useId().replace(/:/g, "")
	const stroke = validateCssColor(color) ?? "var(--chart-1)"

	if (points.length < 2) return null

	return (
		<div className={className}>
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
					<defs>
						<linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
							<stop offset="100%" stopColor={stroke} stopOpacity={0} />
						</linearGradient>
					</defs>
					<Area
						type="monotone"
						dataKey="v"
						stroke={stroke}
						strokeWidth={1.5}
						fill={`url(#spark-${gradientId})`}
						dot={false}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	)
}
