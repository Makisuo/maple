import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { ListWorkloadsResponse } from "@maple/domain/http"
import type { WorkloadKind } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { UsageBar } from "./usage-bar"
import { ColumnHead, DataTable, MetaChip, ROW_LINK_CLASS, useTableSort } from "./primitives/data-table"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

export type WorkloadRow = ListWorkloadsResponse["data"][number]

type SortKey = "workloadName" | "namespace" | "podCount" | "avgCpuLimitPct" | "avgMemoryLimitPct" | "lastSeen"

interface WorkloadTableProps {
	workloads: ReadonlyArray<WorkloadRow>
	kind: WorkloadKind
	waiting?: boolean
	referenceTime?: string
}

export function WorkloadTableLoading() {
	return (
		<DataTable.Root ariaLabel="Workloads">
			<DataTable.Head>
				<ColumnHead label="Workload" width="flex-1 min-w-[260px]" />
				<ColumnHead label="Status" width="w-[88px]" />
				<ColumnHead label="Pods" align="right" width="w-[60px]" />
				<ColumnHead label="Avg CPU" align="right" width="w-[160px]" hidden="hidden md:flex" />
				<ColumnHead label="Avg memory" align="right" width="w-[160px]" hidden="hidden lg:flex" />
				<ColumnHead label="Last seen" align="right" width="w-[100px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<div className="min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-32" />
				</div>
				<Skeleton className="h-3 w-[88px]" />
				<Skeleton className="h-3 w-[60px]" />
				<Skeleton className="hidden h-3 w-[160px] md:block" />
				<Skeleton className="hidden h-3 w-[160px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function WorkloadTable({ workloads, kind, waiting, referenceTime }: WorkloadTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<WorkloadRow, SortKey>(workloads, {
		initialKey: "avgCpuLimitPct",
		stringKeys: ["workloadName", "namespace"],
	})

	return (
		<DataTable.Root ariaLabel="Workloads" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<SortKey>
					label="Workload"
					sortKey="workloadName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="flex-1 min-w-[260px]"
				/>
				<ColumnHead label="Status" width="w-[88px]" />
				<ColumnHead<SortKey>
					label="Pods"
					sortKey="podCount"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[60px]"
				/>
				<ColumnHead<SortKey>
					label="Avg CPU"
					sortKey="avgCpuLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[160px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<SortKey>
					label="Avg memory"
					sortKey="avgMemoryLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[160px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<SortKey>
					label="Last seen"
					sortKey="lastSeen"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
				/>
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>No workloads match your filter.</DataTable.Empty>}

			{sorted.map((wl) => (
				<Link
					key={`${wl.namespace}/${wl.workloadName}`}
					to="/infra/kubernetes/workloads/$kind/$workloadName"
					params={{ kind, workloadName: wl.workloadName }}
					search={wl.namespace ? { namespace: wl.namespace } : {}}
					className={ROW_LINK_CLASS}
				>
					<div className="min-w-[260px] flex-1">
						<div className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
							{wl.workloadName}
						</div>
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
							{wl.namespace && <MetaChip>ns {wl.namespace}</MetaChip>}
							<span className="text-foreground/20">·</span>
							<MetaChip>kind {kind}</MetaChip>
						</div>
					</div>
					<div className="w-[88px]">
						<HostStatusBadge lastSeen={wl.lastSeen} referenceTime={referenceTime} />
					</div>
					<div className="w-[60px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{wl.podCount}
					</div>
					<div className="hidden w-[160px] md:block">
						<UsageBar fraction={wl.avgCpuLimitPct} />
					</div>
					<div className="hidden w-[160px] lg:block">
						<UsageBar fraction={wl.avgMemoryLimitPct} />
					</div>
					<div className="w-[100px] text-right">
						<Tooltip>
							<TooltipTrigger
								render={<span />}
								className="cursor-default font-mono text-[11px] text-muted-foreground"
							>
								{formatRelativeTime(wl.lastSeen)}
							</TooltipTrigger>
							<TooltipContent>{wl.lastSeen}</TooltipContent>
						</Tooltip>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
