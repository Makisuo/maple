import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleBranchStat } from "@/api/warehouse/service-map"
import { formatNumber } from "@/lib/format"
import { ColumnHead, TableShell, useTableSort } from "../primitives/data-table"
import { formatLag, lagClass, utilizationClass } from "./planetscale-database-table"

type SortKey = "branch" | "connectionsAvg" | "cpuMaxPercent" | "memMaxPercent" | "replicaLagMaxSeconds"

/**
 * Per-branch health for one database. Branch flags (production/ready) come from
 * the polled inventory; the metric columns from the window's rollups.
 */
export function PlanetScaleBranchTable({
	branches,
	branchInfoByName,
	waiting,
}: {
	branches: ReadonlyArray<PlanetScaleBranchStat>
	branchInfoByName: ReadonlyMap<string, { production: boolean; ready: boolean }>
	waiting?: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<PlanetScaleBranchStat, SortKey>(
		branches,
		{ initialKey: "connectionsAvg", stringKeys: ["branch"] },
	)

	return (
		<TableShell
			ariaLabel="PlanetScale branches"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No branch metrics in the selected window."
			header={
				<>
					<ColumnHead<SortKey>
						label="Branch"
						sortKey="branch"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="flex-1 min-w-[200px]"
					/>
					<ColumnHead<SortKey>
						label="Connections"
						sortKey="connectionsAvg"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[96px]"
					/>
					<ColumnHead<SortKey>
						label="CPU (max)"
						sortKey="cpuMaxPercent"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[88px]"
					/>
					<ColumnHead<SortKey>
						label="Memory (max)"
						sortKey="memMaxPercent"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[104px]"
						hidden="hidden md:flex"
					/>
					<ColumnHead<SortKey>
						label="Replica lag"
						sortKey="replicaLagMaxSeconds"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[88px]"
					/>
				</>
			}
		>
			{sorted.map((row) => {
				const info = branchInfoByName.get(row.branch)
				return (
					<div
						key={row.branch}
						className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
					>
						<div className="flex min-w-[200px] flex-1 items-center gap-2 overflow-hidden">
							<span className="truncate font-mono text-[13px] text-foreground">{row.branch}</span>
							{info?.production ? (
								<Badge variant="outline" className="shrink-0">
									production
								</Badge>
							) : null}
							{info !== undefined && !info.ready ? (
								<Badge variant="warning" className="shrink-0">
									provisioning
								</Badge>
							) : null}
						</div>
						<div className="w-[96px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
							{formatNumber(row.connectionsAvg)}
						</div>
						<div
							className={cn(
								"w-[88px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								utilizationClass(row.cpuMaxPercent),
							)}
						>
							{row.cpuMaxPercent.toFixed(0)}%
						</div>
						<div
							className={cn(
								"hidden w-[104px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block",
								utilizationClass(row.memMaxPercent),
							)}
						>
							{row.memMaxPercent.toFixed(0)}%
						</div>
						<div
							className={cn(
								"w-[88px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								lagClass(row.replicaLagMaxSeconds),
							)}
						>
							{formatLag(row.replicaLagMaxSeconds)}
						</div>
					</div>
				)
			})}
		</TableShell>
	)
}
