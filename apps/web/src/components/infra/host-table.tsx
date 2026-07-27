import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { ListHostsResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { InlineMetricBars } from "./primitives/inline-bars"
import {
	ColumnHead,
	DataTable,
	type SortControls,
	MetaChip,
	ROW_LINK_CLASS,
	useTableSort,
} from "./primitives/data-table"
import { formatLoad } from "@maple/ui/format"
import { formatRelativeTime } from "@maple/ui/time-format"

export type HostRow = ListHostsResponse["data"][number]

type SortKey = "cpuPct" | "memoryPct" | "diskPct" | "load15" | "lastSeen" | "hostName"

interface HostTableProps {
	hosts: ReadonlyArray<HostRow>
	waiting?: boolean
}

/**
 * The column list, declared once and rendered by both the table and its skeleton.
 * Pass `sort` to make the sortable columns interactive; the skeleton omits it, so
 * the two can no longer drift apart on widths.
 */
function HostColumns({ sort }: { sort?: SortControls<SortKey> }) {
	return (
		<>
			<ColumnHead<SortKey> label="Host" sortKey="hostName" {...sort} width="flex-1 min-w-[260px]" />
			<ColumnHead label="Status" width="w-[88px]" />
			<ColumnHead label="Usage" width="w-[200px]" />
			<ColumnHead<SortKey>
				label="Load 15m"
				sortKey="load15"
				{...sort}
				align="right"
				width="w-[80px]"
				hidden="hidden lg:flex"
			/>
			<ColumnHead<SortKey>
				label="Last seen"
				sortKey="lastSeen"
				{...sort}
				align="right"
				width="w-[100px]"
			/>
		</>
	)
}

export function HostTableLoading() {
	return (
		<DataTable.Root ariaLabel="Hosts">
			<DataTable.Head>
				<HostColumns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={6}>
				<div className="min-w-[260px] flex-1">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="mt-1.5 h-3 w-32" />
				</div>
				<Skeleton className="h-3 w-[88px]" />
				<Skeleton className="h-9 w-[200px]" />
				<Skeleton className="ml-auto hidden h-3 w-[80px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function HostTable({ hosts, waiting }: HostTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<HostRow, SortKey>(hosts, {
		initialKey: "cpuPct",
		stringKeys: ["hostName"],
	})

	return (
		<DataTable.Root ariaLabel="Hosts" waiting={waiting}>
			<DataTable.Head>
				<HostColumns sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }} />
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>No hosts match your search.</DataTable.Empty>}
			{sorted.map((host) => (
				<Link
					key={host.hostName}
					to="/infra/$hostName"
					params={{ hostName: host.hostName }}
					className={ROW_LINK_CLASS}
				>
					<div className="min-w-[260px] flex-1">
						<div className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
							{host.hostName}
						</div>
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
							{host.osType && <MetaChip>{host.osType}</MetaChip>}
							{host.hostArch && (
								<>
									<span className="text-foreground/20">·</span>
									<MetaChip>{host.hostArch}</MetaChip>
								</>
							)}
							{host.cloudProvider && (
								<>
									<span className="text-foreground/20">·</span>
									<MetaChip>{host.cloudProvider}</MetaChip>
								</>
							)}
						</div>
					</div>
					<div className="w-[88px]">
						<HostStatusBadge lastSeen={host.lastSeen} />
					</div>
					<div className="w-[200px]">
						<InlineMetricBars cpu={host.cpuPct} memory={host.memoryPct} disk={host.diskPct} />
					</div>
					<div className="hidden w-[80px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatLoad(host.load15)}
					</div>
					<div className="w-[100px] text-right">
						<Tooltip>
							<TooltipTrigger
								render={<span />}
								className="cursor-default font-mono text-[11px] text-muted-foreground"
							>
								{formatRelativeTime(host.lastSeen)}
							</TooltipTrigger>
							<TooltipContent>{host.lastSeen}</TooltipContent>
						</Tooltip>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
