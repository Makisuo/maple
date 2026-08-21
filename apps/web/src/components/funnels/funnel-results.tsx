import { Suspense } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { QueryBuilderFunnelChart } from "@maple/ui/components/charts/funnel/query-builder-funnel-chart"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"

import { ColumnHead, DataTable } from "@/components/infra/primitives/data-table"
import { shareBar } from "@/components/infra/primitives/share-bar"
import { funnelStepStats, groupBreakdownRows, overallConversion, type FunnelStepStat } from "./conversion"
import { breakdownLabel, type FunnelBreakdownBy } from "./definition"

// The results half of a funnel: the same funnel chart the dashboard widget
// draws (reused from the chart registry — it already takes `{ name, value }`
// rows) over a step table with the numbers a chart cannot carry legibly at ten
// steps: count, share of step 1, conversion from the previous step, and the
// drop-off. A breakdown, when asked for, is a small grouped table underneath.

/** Label line + bar per row in the funnel chart, plus its "+N more" allowance. */
const CHART_ROW_PX = 28
const CHART_PAD_PX = 24

const fmtPct = (fraction: number | null): string => (fraction === null ? "—" : formatPercent(fraction))

interface FunnelResultsProps {
	labels: ReadonlyArray<string>
	rows: ReadonlyArray<{ readonly step: number; readonly count: number }>
	/** What one count means: "persons", "visitors", "users", "sessions". */
	unitNoun: string
	waiting?: boolean
	className?: string
}

export function FunnelResults({ labels, rows, unitNoun, waiting = false, className }: FunnelResultsProps) {
	const stats = funnelStepStats(labels, rows)
	const conversion = overallConversion(stats)
	const entered = stats[0]?.count ?? 0
	const completed = stats[stats.length - 1]?.count ?? 0
	const chartRows = stats.map((stat) => ({ name: stat.label, value: stat.count }))
	const chartHeight = Math.max(120, stats.length * CHART_ROW_PX + CHART_PAD_PX)

	return (
		<div className={cn("space-y-4 transition-opacity", waiting && "opacity-60", className)}>
			<div className="rounded-md border bg-card">
				<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 pt-3 pb-2">
					<div className="flex items-baseline gap-2">
						<span className="text-2xl font-semibold tabular-nums tracking-tight">
							{conversion === null ? "—" : formatPercent(conversion)}
						</span>
						<span className="text-xs text-muted-foreground">
							{stats.length < 2 ? "conversion needs two steps" : "converted end to end"}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
						<span>
							<span className="text-foreground">{formatNumber(entered)}</span> {unitNoun}{" "}
							entered
						</span>
						{stats.length >= 2 ? (
							<span>
								<span className="text-foreground">{formatNumber(completed)}</span> completed
							</span>
						) : null}
					</div>
				</div>
				<div className="px-4 pb-4" style={{ height: chartHeight }}>
					{entered === 0 ? (
						<div className="grid h-full place-items-center text-[12px] text-muted-foreground">
							Nobody matched step 1 in this window.
						</div>
					) : (
						<Suspense fallback={<ChartSkeleton variant="funnel" />}>
							<QueryBuilderFunnelChart data={chartRows} className="h-full w-full" showStepPercent />
						</Suspense>
					)}
				</div>
			</div>

			<div className="rounded-md border bg-card">
				<FunnelStepTable stats={stats} unitNoun={unitNoun} />
			</div>
		</div>
	)
}

function FunnelStepTable({ stats, unitNoun }: { stats: ReadonlyArray<FunnelStepStat>; unitNoun: string }) {
	const max = stats.reduce((acc, stat) => Math.max(acc, stat.count), 0)
	return (
		<DataTable.Root ariaLabel="Funnel steps" stickySurfaceClass="bg-card">
			<DataTable.Head>
				<ColumnHead label="#" width="w-5" align="right" />
				<ColumnHead label="Step" width="flex-1 min-w-0" />
				<ColumnHead label={capitalize(unitNoun)} width="w-20" align="right" />
				<ColumnHead label="Of first" width="w-16" align="right" hidden="max-sm:hidden" />
				<ColumnHead label="Of previous" width="w-20" align="right" />
				<ColumnHead label="Drop-off" width="w-24" align="right" hidden="max-sm:hidden" />
			</DataTable.Head>
			{stats.map((stat) => (
				<div
					key={stat.step}
					style={shareBar(max > 0 ? stat.count / max : 0)}
					className="flex items-center gap-4 border-b border-border/40 px-4 py-2 text-[12px] last:border-0"
				>
					<span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
						{stat.step}
					</span>
					<span className="min-w-0 flex-1 truncate" title={stat.label}>
						{stat.label}
					</span>
					<span className="w-20 shrink-0 text-right font-mono tabular-nums">
						{formatNumber(stat.count)}
					</span>
					<span className="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground max-sm:hidden">
						{fmtPct(stat.ofFirst)}
					</span>
					<span className="w-20 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
						{fmtPct(stat.ofPrevious)}
					</span>
					<span className="w-24 shrink-0 text-right font-mono tabular-nums text-muted-foreground max-sm:hidden">
						{stat.step === 1 ? "—" : `−${formatNumber(stat.dropOff)}`}
						{stat.dropOffRate !== null ? (
							<span className="text-muted-foreground/60"> · {fmtPct(stat.dropOffRate)}</span>
						) : null}
					</span>
				</div>
			))}
		</DataTable.Root>
	)
}

interface FunnelBreakdownTableProps {
	labels: ReadonlyArray<string>
	breakdownBy: FunnelBreakdownBy
	rows: ReadonlyArray<{ readonly group: string; readonly step: number; readonly count: number }>
	waiting?: boolean
}

/** One row per group, one numeric column per step, and the group's end-to-end conversion. */
export function FunnelBreakdownTable({
	labels,
	breakdownBy,
	rows,
	waiting = false,
}: FunnelBreakdownTableProps) {
	const groups = groupBreakdownRows(labels.length, rows)
	const maxFirst = groups.reduce((acc, group) => Math.max(acc, group.counts[0] ?? 0), 0)
	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-2.5 pb-2">
				<span className="text-xs font-medium">
					By {breakdownLabel(breakdownBy)}
					<span className="text-muted-foreground"> · top {groups.length} by step 1</span>
				</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					first non-empty value per person
				</span>
			</div>
			<DataTable.Root
				ariaLabel={`Funnel by ${breakdownLabel(breakdownBy)}`}
				waiting={waiting}
				stickySurfaceClass="bg-card"
			>
				<DataTable.Head>
					<ColumnHead label={capitalize(breakdownLabel(breakdownBy))} width="flex-1 min-w-0" />
					{labels.map((_label, index) => (
						<ColumnHead
							key={index}
							label={`${index + 1}`}
							width="w-16"
							align="right"
							hidden={index > 0 && index < labels.length - 1 ? "max-md:hidden" : undefined}
						/>
					))}
					<ColumnHead label="Conv." width="w-16" align="right" />
				</DataTable.Head>
				{groups.length === 0 ? (
					<DataTable.Empty>No groups — nobody matched step 1 in this window.</DataTable.Empty>
				) : (
					groups.map((group) => {
						const first = group.counts[0] ?? 0
						const last = group.counts[group.counts.length - 1] ?? 0
						return (
							<div
								key={group.group}
								style={shareBar(maxFirst > 0 ? first / maxFirst : 0)}
								className="flex items-center gap-4 border-b border-border/40 px-4 py-2 text-[12px] last:border-0"
							>
								<span
									className={cn(
										"min-w-0 flex-1 truncate",
										group.group === "" && "italic text-muted-foreground",
									)}
									title={group.group}
								>
									{group.group === "" ? "(none)" : group.group}
								</span>
								{group.counts.map((count, index) => (
									<span
										key={index}
										className={cn(
											"w-16 shrink-0 text-right font-mono tabular-nums",
											index > 0 && "text-muted-foreground",
											index > 0 && index < group.counts.length - 1 && "max-md:hidden",
										)}
									>
										{formatNumber(count)}
									</span>
								))}
								<span className="w-16 shrink-0 text-right font-mono tabular-nums">
									{labels.length < 2 || first <= 0 ? "—" : formatPercent(last / first)}
								</span>
							</div>
						)
					})
				)}
			</DataTable.Root>
		</div>
	)
}

const capitalize = (value: string) => (value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value)
