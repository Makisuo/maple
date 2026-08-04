import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { ListNodesResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { ColumnHead, DataTable, MetaChip, ROW_LINK_CLASS, useTableSort } from "./primitives/data-table"
import { formatUptime } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

export type NodeRow = ListNodesResponse["data"][number]

type SortKey = "nodeName" | "cpuUsage" | "uptime" | "lastSeen"

interface NodeTableProps {
	nodes: ReadonlyArray<NodeRow>
	waiting?: boolean
	referenceTime?: string
}

export function NodeTableLoading() {
	return (
		<DataTable.Root ariaLabel="Nodes">
			<DataTable.Head>
				<ColumnHead label="Node" width="flex-1 min-w-[260px]" />
				<ColumnHead label="Status" width="w-[88px]" />
				<ColumnHead label="CPU cores" align="right" width="w-[110px]" hidden="hidden md:flex" />
				<ColumnHead label="Uptime" align="right" width="w-[100px]" hidden="hidden md:flex" />
				<ColumnHead label="Last seen" align="right" width="w-[100px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<div className="min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-32" />
				</div>
				<Skeleton className="h-3 w-[88px]" />
				<Skeleton className="hidden h-3 w-[110px] md:block" />
				<Skeleton className="hidden h-3 w-[100px] md:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function NodeTable({ nodes, waiting, referenceTime }: NodeTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<NodeRow, SortKey>(nodes, {
		initialKey: "cpuUsage",
		stringKeys: ["nodeName"],
	})

	return (
		<DataTable.Root ariaLabel="Nodes" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<SortKey>
					label="Node"
					sortKey="nodeName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="flex-1 min-w-[260px]"
				/>
				<ColumnHead label="Status" width="w-[88px]" />
				<ColumnHead<SortKey>
					label="CPU cores"
					sortKey="cpuUsage"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[110px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<SortKey>
					label="Uptime"
					sortKey="uptime"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
					hidden="hidden md:flex"
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
			{sorted.length === 0 && <DataTable.Empty>No nodes match your search.</DataTable.Empty>}

			{sorted.map((node) => (
				<Link
					key={node.nodeName}
					to="/infra/kubernetes/nodes/$nodeName"
					params={{ nodeName: node.nodeName }}
					className={ROW_LINK_CLASS}
				>
					<div className="min-w-[260px] flex-1">
						<div className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
							{node.nodeName}
						</div>
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
							{node.kubeletVersion && <MetaChip>kubelet {node.kubeletVersion}</MetaChip>}
						</div>
					</div>
					<div className="w-[88px]">
						<HostStatusBadge lastSeen={node.lastSeen} referenceTime={referenceTime} />
					</div>
					<div className="hidden w-[110px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
						{Number.isFinite(node.cpuUsage) ? node.cpuUsage.toFixed(2) : "—"}
					</div>
					<div className="hidden w-[100px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
						{formatUptime(node.uptime)}
					</div>
					<div className="w-[100px] text-right">
						<Tooltip>
							<TooltipTrigger
								render={<span />}
								className="cursor-default font-mono text-[11px] text-muted-foreground"
							>
								{formatRelativeTime(node.lastSeen)}
							</TooltipTrigger>
							<TooltipContent>{node.lastSeen}</TooltipContent>
						</Tooltip>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
