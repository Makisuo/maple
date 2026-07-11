import { useMemo } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { planetscaleQueryInsightsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatLatency, formatNumber } from "@/lib/format"

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
	const result = useRefreshableAtomValue(planetscaleQueryInsightsResultAtom(input))

	if (Result.isInitial(result)) {
		return <Skeleton className={cn("h-24 w-full", className)} />
	}
	if (Result.isFailure(result)) {
		return (
			<p className={cn("text-xs text-muted-foreground", className)}>
				PlanetScale Query Insights are unavailable right now.
			</p>
		)
	}
	const response = result.value
	if (response.unavailableReason) {
		return <p className={cn("text-xs text-muted-foreground", className)}>{response.unavailableReason}</p>
	}
	if (response.rows.length === 0) {
		return (
			<p className={cn("text-xs text-muted-foreground", className)}>
				No queries recorded on {database}/{response.branch} in this window.
			</p>
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
						<span className="font-mono tabular-nums">
							{formatNumber(row.queryCount)} calls
						</span>
						<span className="font-mono tabular-nums">
							p50 {formatLatency(row.p50LatencyMillis)}
						</span>
						<span className="font-mono tabular-nums">
							p99 {formatLatency(row.p99LatencyMillis)}
						</span>
						<span className="font-mono tabular-nums">
							{formatNumber(row.rowsReadPerQuery)} rows read/query
						</span>
						{row.statementType ? <span className="uppercase">{row.statementType}</span> : null}
					</div>
				</div>
			))}
		</div>
	)
}
