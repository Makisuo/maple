import { useMemo } from "react"

import { QueryBuilderAreaChart } from "@maple/ui/components/charts"

import type { RendererComponentProps } from "./types"

interface QueryChartProps {
	data: Array<{ bucket: string; series: Record<string, number> }>
	metric: string
	unit: string
	source: string
	groupBy?: string
}

/**
 * The chart an agent response embeds for a query result.
 *
 * This is the query builder's area chart with a caption — the same rows, the
 * same units, the same semantic series colours — so it renders through the same
 * component rather than reimplementing it.
 *
 * What that removed was a whole layer of key mangling: the Recharts original
 * sanitised every series name into a CSS-variable-safe token (`cssKey`), kept a
 * `Map` from the original to the safe name, re-keyed every row, and rebuilt a
 * config from both. `normaliseTimeseriesRows` already remaps arbitrary group-by
 * text to `s1..sN` for exactly that reason, and keeps the raw key as the label.
 */
export function QueryChart({ props }: RendererComponentProps<QueryChartProps>) {
	const { data, metric, unit } = props

	// `{ bucket, series: { … } }` flattened to the `{ bucket, ...series }` shape
	// every query-builder chart takes.
	const rows = useMemo(() => data.map((point) => ({ bucket: point.bucket, ...point.series })), [data])

	if (rows.length === 0) {
		return (
			<div className="flex h-[140px] items-center justify-center text-[11px] text-muted-foreground">
				No data points
			</div>
		)
	}

	return (
		<div className="space-y-1">
			<p className="text-[11px] font-medium text-muted-foreground">{metric}</p>
			{/*
			 * `legend="hidden"`: the Recharts original drew no `<Legend>`. Nothing
			 * opens a legend slot around an agent message either, so the series are
			 * identified by the tooltip alone, as before.
			 */}
			<QueryBuilderAreaChart
				data={rows}
				unit={unit}
				legend="hidden"
				curveType="monotone"
				className="h-[140px] w-full"
			/>
		</div>
	)
}
