import { Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleDatabaseSummary } from "@maple/domain/http"
import type { PlanetScaleDatabaseStat } from "@/api/warehouse/service-map"
import { formatNumber } from "@/lib/format"
import {
	ColumnHead,
	MetaChip,
	ROW_LINK_CLASS,
	TableShell,
	TableSkeleton,
	useTableSort,
} from "../primitives/data-table"

export const formatLag = (seconds: number) =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

export function utilizationClass(percent: number): string | undefined {
	if (percent > 80) return "text-severity-error"
	if (percent > 60) return "text-severity-warn"
	return undefined
}

export function lagClass(seconds: number): string | undefined {
	if (seconds > 10) return "text-severity-error"
	if (seconds > 1) return "text-severity-warn"
	return undefined
}

/** States that indicate the database isn't serving normally — worth a badge. */
export function abnormalState(state: string | null): string | null {
	if (state === null) return null
	const normalized = state.toLowerCase()
	return normalized === "ready" || normalized === "active" ? null : normalized
}

type SortKey =
	| "name"
	| "branchCount"
	| "connectionsAvg"
	| "cpuMaxPercent"
	| "memMaxPercent"
	| "replicaLagMaxSeconds"

interface DatabaseRow {
	id: string
	name: string
	kind: string
	region: string | null
	plan: string | null
	state: string | null
	branchCount: number
	hasStats: boolean
	connectionsAvg: number
	cpuMaxPercent: number
	memMaxPercent: number
	replicaLagMaxSeconds: number
}

// Databases with no metrics in the window sort below every real value.
const MISSING = Number.NEGATIVE_INFINITY

const headerCells = (sort?: {
	sortKey: SortKey
	sortDir: "asc" | "desc"
	handleSort: (k: SortKey) => void
}) => (
	<>
		<ColumnHead<SortKey>
			label="Database"
			sortKey={sort ? "name" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			width="flex-1 min-w-[220px]"
		/>
		<ColumnHead<SortKey>
			label="Branches"
			sortKey={sort ? "branchCount" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[80px]"
			hidden="hidden md:flex"
		/>
		<ColumnHead<SortKey>
			label="Connections"
			sortKey={sort ? "connectionsAvg" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[96px]"
		/>
		<ColumnHead<SortKey>
			label="CPU (max)"
			sortKey={sort ? "cpuMaxPercent" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[88px]"
		/>
		<ColumnHead<SortKey>
			label="Memory (max)"
			sortKey={sort ? "memMaxPercent" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[104px]"
			hidden="hidden md:flex"
		/>
		<ColumnHead<SortKey>
			label="Replica lag"
			sortKey={sort ? "replicaLagMaxSeconds" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[88px]"
		/>
	</>
)

export function PlanetScaleDatabaseTableLoading() {
	return (
		<TableSkeleton
			rows={3}
			header={headerCells()}
			renderRowCells={() => (
				<>
					<div className="min-w-[220px] flex-1">
						<Skeleton className="h-4 w-44" />
					</div>
					<Skeleton className="hidden h-3 w-[80px] md:block" />
					<Skeleton className="h-3 w-[96px]" />
					<Skeleton className="h-3 w-[88px]" />
					<Skeleton className="hidden h-3 w-[104px] md:block" />
					<Skeleton className="h-3 w-[88px]" />
				</>
			)}
		/>
	)
}

/**
 * Fleet table: one row per database from the polled inventory, joined with the
 * window's metric rollups. Databases with no metrics in the window (excluded
 * branches, asleep) still render with muted dashes and sort last.
 */
export function PlanetScaleDatabaseTable({
	databases,
	statsByName,
	waiting,
}: {
	databases: ReadonlyArray<PlanetScaleDatabaseSummary>
	statsByName: ReadonlyMap<string, PlanetScaleDatabaseStat>
	waiting?: boolean
}) {
	const rows: DatabaseRow[] = databases.map((db) => {
		const stats = statsByName.get(db.name.toLowerCase())
		return {
			id: db.id,
			name: db.name,
			kind: db.kind,
			region: db.region,
			plan: db.plan,
			state: db.state,
			branchCount: db.branches.length,
			hasStats: stats !== undefined,
			connectionsAvg: stats?.connectionsAvg ?? MISSING,
			cpuMaxPercent: stats?.cpuMaxPercent ?? MISSING,
			memMaxPercent: stats?.memMaxPercent ?? MISSING,
			replicaLagMaxSeconds: stats?.replicaLagMaxSeconds ?? MISSING,
		}
	})

	const { sorted, sortKey, sortDir, handleSort } = useTableSort<DatabaseRow, SortKey>(rows, {
		initialKey: "connectionsAvg",
		stringKeys: ["name"],
	})

	return (
		<TableShell
			ariaLabel="PlanetScale databases"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No databases in the inventory."
			header={headerCells({ sortKey, sortDir, handleSort })}
		>
			{sorted.map((row) => {
				const state = abnormalState(row.state)
				return (
					<Link
						key={row.id}
						to="/infra/planetscale/$dbName"
						params={{ dbName: row.name }}
						className={ROW_LINK_CLASS}
					>
						<div className="flex min-w-[220px] flex-1 items-center gap-2 overflow-hidden">
							<span className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
								{row.name}
							</span>
							<Badge variant="outline" className="shrink-0">
								{row.kind === "postgresql" ? "Postgres" : "MySQL"}
							</Badge>
							{state !== null ? (
								<Badge variant="warning" className="shrink-0">
									{state}
								</Badge>
							) : null}
							{row.region ? <MetaChip>{row.region}</MetaChip> : null}
							{row.plan ? <MetaChip>{row.plan}</MetaChip> : null}
						</div>
						<div className="hidden w-[80px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
							{row.branchCount}
						</div>
						<div className="w-[96px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
							{row.hasStats ? formatNumber(row.connectionsAvg) : "—"}
						</div>
						<div
							className={cn(
								"w-[88px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								row.hasStats && utilizationClass(row.cpuMaxPercent),
							)}
						>
							{row.hasStats ? `${row.cpuMaxPercent.toFixed(0)}%` : "—"}
						</div>
						<div
							className={cn(
								"hidden w-[104px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block",
								row.hasStats && utilizationClass(row.memMaxPercent),
							)}
						>
							{row.hasStats ? `${row.memMaxPercent.toFixed(0)}%` : "—"}
						</div>
						<div
							className={cn(
								"w-[88px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								row.hasStats && lagClass(row.replicaLagMaxSeconds),
							)}
						>
							{row.hasStats ? formatLag(row.replicaLagMaxSeconds) : "—"}
						</div>
					</Link>
				)
			})}
		</TableShell>
	)
}
