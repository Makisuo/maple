import { useMemo } from "react"
import { Area, ComposedChart, CartesianGrid, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { formatCurrency } from "@/lib/billing/currency"
import {
	buildCumulativeSeries,
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

const CHART_HEIGHT = 260

const chartConfig: ChartConfig = {
	base: { label: "Base plan", color: "#57534a" },
	logs: { label: FEATURE_SHORT_LABELS.logs, color: FEATURE_COLORS.logs },
	traces: { label: FEATURE_SHORT_LABELS.traces, color: FEATURE_COLORS.traces },
	metrics: { label: FEATURE_SHORT_LABELS.metrics, color: FEATURE_COLORS.metrics },
	browser_sessions: {
		label: FEATURE_SHORT_LABELS.browser_sessions,
		color: FEATURE_COLORS.browser_sessions,
	},
}

const BANDS = ["base", ...SPEND_FEATURES] as const

export function SpendChartSkeleton() {
	return <Skeleton className="h-[300px] w-full rounded-none" />
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
		} satisfies Record<(typeof BANDS)[number], number>
	}, [data])
	const lastPoint = data[data.length - 1]
	const hasFuture = lastPoint !== undefined && lastPoint.future

	if (data.length === 0) {
		return (
			<div className="flex h-[300px] items-center justify-center border border-dashed border-border/60 font-mono text-[11px] text-muted-foreground">
				No ingest recorded this cycle yet
			</div>
		)
	}

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
				    color: a row of five dots tells you which color is which, but not
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
				<ChartContainer config={chartConfig} className="w-full" style={{ height: CHART_HEIGHT }}>
					<ComposedChart data={[...data]} margin={{ top: 8, right: 56, left: 0, bottom: 0 }}>
						<CartesianGrid vertical={false} strokeDasharray="2 4" />
						<XAxis
							dataKey="date"
							tickLine={false}
							axisLine={false}
							minTickGap={40}
							tickFormatter={(value: string) =>
								new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
									month: "short",
									day: "numeric",
									timeZone: "UTC",
								})
							}
							className="font-mono text-[10px]"
						/>
						<YAxis
							domain={[0, yMax]}
							tickLine={false}
							axisLine={false}
							width={52}
							tickFormatter={(value: number) => `$${Math.round(value)}`}
							className="font-mono text-[10px]"
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									labelFormatter={(label) =>
										new Date(`${String(label)}T00:00:00Z`).toLocaleDateString("en-US", {
											month: "short",
											day: "numeric",
											timeZone: "UTC",
										})
									}
									formatter={(value) => formatCurrency(Number(value), model.currency)}
								/>
							}
						/>
						{BANDS.map((band) => (
							<Area
								key={band}
								dataKey={band}
								type="monotone"
								stackId="spend"
								stroke={chartConfig[band]?.color}
								fill={chartConfig[band]?.color}
								fillOpacity={0.35}
								strokeWidth={1}
								isAnimationActive={false}
							/>
						))}
						{/* The projection: today's actual total joined to where the cycle
						    lands, dashed because it hasn't happened. */}
						{hasFuture && (
							<Line
								dataKey="projected"
								type="linear"
								stroke="var(--color-primary)"
								strokeDasharray="4 4"
								strokeWidth={1.5}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
						)}
						{hasFuture && lastPoint && (
							<ReferenceDot
								x={lastPoint.date}
								y={projected}
								r={3}
								fill="var(--color-primary)"
								stroke="none"
								label={{
									value: `${formatCurrency(projected, model.currency)} projected`,
									position: "top",
									fill: "var(--color-primary)",
									fontSize: 10,
								}}
							/>
						)}
						{todayPoint && (
							<ReferenceLine
								x={todayPoint.date}
								stroke="var(--color-border)"
								label={{
									value: "Today",
									position: "insideTopLeft",
									fill: "var(--color-muted-foreground)",
									fontSize: 10,
								}}
							/>
						)}
					</ComposedChart>
				</ChartContainer>
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
