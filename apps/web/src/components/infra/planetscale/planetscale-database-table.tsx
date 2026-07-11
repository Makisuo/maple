import { Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleDatabaseSummary } from "@maple/domain/http"
import type { PlanetScaleDatabaseStat } from "@/api/warehouse/service-map"
import { formatNumber } from "@/lib/format"

export function PlanetScaleDatabaseTableLoading() {
	return <Skeleton className="h-64 w-full" />
}

const formatLag = (seconds: number) =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

function utilizationClass(percent: number): string | undefined {
	if (percent > 80) return "text-severity-error"
	if (percent > 60) return "text-severity-warn"
	return undefined
}

function lagClass(seconds: number): string | undefined {
	if (seconds > 10) return "text-severity-error"
	if (seconds > 1) return "text-severity-warn"
	return undefined
}

/**
 * Fleet table: one row per database from the polled inventory, joined with the
 * window's scraped-metric rollups. Databases with no metrics in the window
 * (excluded branches, asleep) still render with muted dashes.
 */
export function PlanetScaleDatabaseTable({
	databases,
	statsByName,
}: {
	databases: ReadonlyArray<PlanetScaleDatabaseSummary>
	statsByName: ReadonlyMap<string, PlanetScaleDatabaseStat>
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-border/60">
			<div className="grid grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))] gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				<span>Database</span>
				<span className="text-right">Branches</span>
				<span className="text-right">Connections</span>
				<span className="text-right">CPU (max)</span>
				<span className="text-right">Memory (max)</span>
				<span className="text-right">Replica lag</span>
			</div>
			{databases.map((db) => {
				const stats = statsByName.get(db.name.toLowerCase())
				return (
					<Link
						key={db.id}
						to="/infra/planetscale/$dbName"
						params={{ dbName: db.name }}
						className="grid grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))] items-center gap-2 border-b border-border/40 px-3 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-muted/40"
					>
						<span className="flex min-w-0 items-center gap-2">
							<span className="truncate font-medium text-foreground">{db.name}</span>
							<Badge variant="outline" className="shrink-0">
								{db.kind === "postgresql" ? "Postgres" : "MySQL"}
							</Badge>
							{db.region ? (
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
									{db.region}
								</span>
							) : null}
						</span>
						<span className="text-right font-mono tabular-nums text-muted-foreground">
							{db.branches.length}
						</span>
						<span className="text-right font-mono tabular-nums">
							{stats ? formatNumber(stats.connectionsAvg) : "—"}
						</span>
						<span
							className={cn(
								"text-right font-mono tabular-nums",
								stats && utilizationClass(stats.cpuMaxPercent),
							)}
						>
							{stats ? `${stats.cpuMaxPercent.toFixed(0)}%` : "—"}
						</span>
						<span
							className={cn(
								"text-right font-mono tabular-nums",
								stats && utilizationClass(stats.memMaxPercent),
							)}
						>
							{stats ? `${stats.memMaxPercent.toFixed(0)}%` : "—"}
						</span>
						<span
							className={cn(
								"text-right font-mono tabular-nums",
								stats && lagClass(stats.replicaLagMaxSeconds),
							)}
						>
							{stats ? formatLag(stats.replicaLagMaxSeconds) : "—"}
						</span>
					</Link>
				)
			})}
		</div>
	)
}
