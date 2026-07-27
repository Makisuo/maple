import { useMemo } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { LatencyValue } from "@maple/ui/components/latency-value"

import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { QueryErrorState } from "@/components/common/query-error-state"
import { planetscaleQueryInsightsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@maple/ui/format"
import { formatRelativeTime } from "@maple/ui/time-format"

/** Bordered like the query rows, so an explanation keeps the section's rhythm. */
function InsightsNotice({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"rounded-md border border-dashed border-border bg-card/50 px-3 py-4 text-center text-xs text-muted-foreground",
				className,
			)}
		>
			{children}
		</div>
	)
}

/** Warehouse "YYYY-MM-DD HH:mm:ss" → epoch ms (values are UTC). */
const warehouseTimeToMs = (value: string): number => new Date(`${value.replace(" ", "T")}Z`).getTime()

/**
 * Top queries from PlanetScale's Query Insights API for one database branch —
 * PlanetScale's own per-fingerprint statistics (rows read, per-query time),
 * complementing the trace-derived query shapes. Live proxy, briefly cached.
 */
export function PlanetScaleTopQueries({
	database,
	branch,
	startTime,
	endTime,
	limit = 8,
	className,
}: {
	database: string
	branch?: string
	/** Warehouse datetime strings ("YYYY-MM-DD HH:mm:ss", UTC). */
	startTime: string
	endTime: string
	limit?: number
	className?: string
}) {
	const input = useMemo(
		() => ({
			data: {
				database,
				...(branch === undefined ? {} : { branch }),
				startTime: warehouseTimeToMs(startTime),
				endTime: warehouseTimeToMs(endTime),
				limit,
			},
		}),
		[database, branch, startTime, endTime, limit],
	)
	const result = useRetainedRefreshableResultValue(planetscaleQueryInsightsResultAtom(input))

	if (Result.isInitial(result)) {
		// Row-shaped, so the section doesn't resize when the rows arrive.
		return (
			<div className={cn("space-y-1.5", className)}>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-[52px] w-full rounded-md" />
				))}
			</div>
		)
	}
	if (Result.isFailure(result)) {
		return (
			<QueryErrorState
				error={result.cause}
				titleOverride="PlanetScale Query Insights are unavailable"
				className={cn(
					"flex flex-col gap-1 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-3 text-xs",
					className,
				)}
			/>
		)
	}
	const response = result.value
	// `unavailableReason` is PlanetScale explaining itself (plan limits, a branch
	// with insights off) — not a transport failure, so it reads as information.
	if (response.unavailableReason) {
		return <InsightsNotice className={className}>{response.unavailableReason}</InsightsNotice>
	}
	if (response.rows.length === 0) {
		return (
			<InsightsNotice className={className}>
				No queries recorded on{" "}
				<span className="font-mono text-foreground/80">
					{database}/{response.branch}
				</span>{" "}
				in this window.
			</InsightsNotice>
		)
	}

	return (
		<div className={cn("space-y-1.5", className)}>
			{response.rows.map((row) => (
				<div key={row.fingerprint} className="rounded-md border border-border bg-card px-2.5 py-2">
					<div className="flex items-start justify-between gap-2">
						<p className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
							{row.normalizedSql}
						</p>
						<span
							className={cn(
								"shrink-0 font-mono text-[10px] tabular-nums",
								row.errorRate > 0.05
									? "text-severity-error"
									: row.errorRate > 0.01
										? "text-severity-warn"
										: "text-muted-foreground",
							)}
						>
							{(row.errorRate * 100).toFixed(1)}%
						</span>
					</div>
					<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
						<span className="font-mono tabular-nums">{formatNumber(row.queryCount)} calls</span>
						<span className="font-mono tabular-nums">
							p50 <LatencyValue ms={row.p50LatencyMillis} scale="p50" className="text-[10px]" />
						</span>
						<span className="font-mono tabular-nums">
							p99 <LatencyValue ms={row.p99LatencyMillis} scale="p99" className="text-[10px]" />
						</span>
						<span className="font-mono tabular-nums">
							{formatNumber(row.rowsReadPerQuery)} rows read/query
						</span>
						{row.statementType ? <span className="uppercase">{row.statementType}</span> : null}
						{row.lastRunAt !== null ? (
							<span className="ml-auto font-mono tabular-nums text-muted-foreground/70">
								last run {formatRelativeTime(new Date(row.lastRunAt).toISOString())}
							</span>
						) : null}
					</div>
				</div>
			))}
		</div>
	)
}
