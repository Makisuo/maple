import { useMemo } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { formatNumber } from "@maple/ui/format"
import { ColumnHead, DataTable, MetaChip, ROW_BUTTON_CLASS, useTableSort } from "../primitives/data-table"
import type { BranchCandidate } from "./branch-selection"
import { MISSING, formatLag, formatStoragePercent, lagClass, utilizationClass } from "./metrics"

type SortKey =
	| "branch"
	| "connectionsAvg"
	| "connectionsMax"
	| "cpuMaxPercent"
	| "memMaxPercent"
	| "storageUsedPercent"
	| "replicaLagMaxSeconds"

interface BranchRow {
	branch: string
	production: boolean
	ready: boolean
	excluded: boolean
	unknownToInventory: boolean
	hasStats: boolean
	connectionsAvg: number
	connectionsMax: number
	cpuMaxPercent: number
	memMaxPercent: number
	storageUsedPercent: number
	replicaLagMaxSeconds: number
}

const headerCells = (sort?: {
	sortKey: SortKey | null
	sortDir: "asc" | "desc"
	handleSort: (k: SortKey) => void
}) => (
	<>
		<ColumnHead<SortKey>
			label="Branch"
			sortKey={sort ? "branch" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			width="flex-1 min-w-[200px]"
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
			label="Peak"
			sortKey={sort ? "connectionsMax" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[72px]"
			hidden="hidden lg:flex"
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
			label="Storage"
			sortKey={sort ? "storageUsedPercent" : undefined}
			currentKey={sort?.sortKey}
			dir={sort?.sortDir}
			onSort={sort?.handleSort}
			align="right"
			width="w-[80px]"
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

export function PlanetScaleBranchTableLoading() {
	return (
		<DataTable.Root ariaLabel="Branches">
			<DataTable.Head>{headerCells()}</DataTable.Head>
			<DataTable.SkeletonRows count={3}>
				<div className="min-w-[200px] flex-1">
					<Skeleton className="h-4 w-40" />
				</div>
				<Skeleton className="h-3 w-[96px]" />
				<Skeleton className="hidden h-3 w-[72px] lg:block" />
				<Skeleton className="h-3 w-[88px]" />
				<Skeleton className="hidden h-3 w-[104px] md:block" />
				<Skeleton className="h-3 w-[80px]" />
				<Skeleton className="h-3 w-[88px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

/**
 * Per-branch health for one database. Rows come from the inventory UNION the
 * rollups, so a branch excluded from scraping or asleep still appears with
 * dashes and a reason — dropping it would leave no way to tell "no such branch"
 * from "no data for that branch".
 *
 * Rows select rather than navigate: picking one re-scopes the charts and query
 * insights above, which is the only thing a branch drill-in could show anyway.
 */
export function PlanetScaleBranchTable({
	candidates,
	selectedBranch,
	onSelectBranch,
	waiting,
	emptyMessage = "No branches in this database.",
}: {
	candidates: ReadonlyArray<BranchCandidate>
	selectedBranch: string | null
	onSelectBranch: (branch: string) => void
	waiting?: boolean
	emptyMessage?: string
}) {
	const rows = useMemo<ReadonlyArray<BranchRow>>(
		() =>
			candidates.map((candidate) => ({
				branch: candidate.name,
				production: candidate.production,
				ready: candidate.ready,
				excluded: candidate.excluded,
				unknownToInventory: candidate.unknownToInventory,
				hasStats: candidate.stat !== null,
				connectionsAvg: candidate.stat?.connectionsAvg ?? MISSING,
				connectionsMax: candidate.stat?.connectionsMax ?? MISSING,
				cpuMaxPercent: candidate.stat?.cpuMaxPercent ?? MISSING,
				memMaxPercent: candidate.stat?.memMaxPercent ?? MISSING,
				storageUsedPercent: candidate.stat?.storageUsedPercent ?? MISSING,
				replicaLagMaxSeconds: candidate.stat?.replicaLagMaxSeconds ?? MISSING,
			})),
		[candidates],
	)

	const { sorted, sortKey, sortDir, handleSort } = useTableSort<BranchRow, SortKey>(rows, {
		initialKey: "connectionsAvg",
		stringKeys: ["branch"],
		// Production is categorically different from an ephemeral PR branch: it
		// stays on top no matter which column is sorted.
		pinned: (row) => row.production,
	})

	return (
		<DataTable.Root ariaLabel="PlanetScale branches" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>{headerCells({ sortKey, sortDir, handleSort })}</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>{emptyMessage}</DataTable.Empty>}

			{sorted.map((row) => {
				const selected = row.branch === selectedBranch
				return (
					<button
						key={row.branch}
						type="button"
						aria-pressed={selected}
						title={`Scope this page to ${row.branch}`}
						onClick={() => onSelectBranch(row.branch)}
						className={cn(ROW_BUTTON_CLASS, "relative", selected && "bg-muted/40")}
					>
						{selected ? (
							<span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-primary" />
						) : null}
						<div className="flex min-w-[200px] flex-1 items-center gap-2 overflow-hidden">
							<span
								className={cn(
									"truncate font-mono text-[13px] transition-colors",
									selected ? "text-foreground" : "text-foreground/90",
								)}
							>
								{row.branch}
							</span>
							{row.production ? (
								<Badge variant="outline" className="shrink-0">
									production
								</Badge>
							) : null}
							{!row.ready ? (
								<Badge variant="warning" className="shrink-0">
									provisioning
								</Badge>
							) : null}
							{row.excluded ? <MetaChip>excluded</MetaChip> : null}
							{row.unknownToInventory ? <MetaChip>not in inventory</MetaChip> : null}
						</div>
						<div className="w-[96px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
							{row.hasStats ? formatNumber(row.connectionsAvg) : "—"}
						</div>
						<div className="hidden w-[72px] text-right font-mono text-[12px] tabular-nums text-muted-foreground lg:block">
							{row.hasStats ? formatNumber(row.connectionsMax) : "—"}
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
								"w-[80px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								row.storageUsedPercent !== MISSING &&
									utilizationClass(row.storageUsedPercent),
							)}
						>
							{row.storageUsedPercent === MISSING
								? "—"
								: formatStoragePercent(row.storageUsedPercent)}
						</div>
						<div
							className={cn(
								"w-[88px] text-right font-mono text-[12px] tabular-nums text-foreground/80",
								row.hasStats && lagClass(row.replicaLagMaxSeconds),
							)}
						>
							{row.hasStats ? formatLag(row.replicaLagMaxSeconds) : "—"}
						</div>
					</button>
				)
			})}
		</DataTable.Root>
	)
}

// A PlanetScale database routinely carries one branch per open PR. Cap the list
// so the page below it stays reachable.
const TABLE_MAX_HEIGHT = 420
