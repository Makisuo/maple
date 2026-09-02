import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { ListContainersResponse } from "@maple/domain/http"
import type { ContainerSortKey, SortDirection } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { ColumnHead, DataTable, ROW_LINK_CLASS } from "./primitives/data-table"
import { MeterRows } from "./primitives/meter-rows"
import { MetaLine } from "./primitives/meta-line"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

export type ContainerRow = ListContainersResponse["data"][number]

interface ContainerTableProps {
	containers: ReadonlyArray<ContainerRow>
	/**
	 * Sorting is server-side — the list is paged, so sorting the page in the
	 * browser would only reorder the rows that already came back (see PodTable).
	 */
	sortBy?: ContainerSortKey
	sortDir?: SortDirection
	onSortChange?: (key: ContainerSortKey) => void
	waiting?: boolean
	referenceTime?: string
}

const formatPct = (fraction: number) => (Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "—")

/** avg → peak. One number can't distinguish a steady 60% from a spike to 100%. */
function AvgPeak({ avg, peak, format }: { avg: number; peak: number; format: (n: number) => string }) {
	return (
		<span className="font-mono text-[11px] tabular-nums text-foreground">
			<span className="text-muted-foreground">{format(avg)}</span>
			<span className="mx-1 text-foreground/30">→</span>
			{format(peak)}
		</span>
	)
}

export function ContainerTableLoading() {
	return (
		<DataTable.Root ariaLabel="Containers">
			<DataTable.Head>
				<ColumnHead label="Container" width="w-0 flex-1 min-w-[260px]" />
				<ColumnHead label="Peak saturation" width="w-[176px]" hidden="hidden md:flex" />
				<ColumnHead label="CPU" align="right" width="w-[132px]" hidden="hidden lg:flex" />
				<ColumnHead label="Mem of limit" align="right" width="w-[120px]" hidden="hidden lg:flex" />
				<ColumnHead label="Last seen" align="right" width="w-[100px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={6}>
				<div className="w-0 min-w-[260px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-40" />
				</div>
				<div className="hidden w-[176px] space-y-1.5 md:block">
					<Skeleton className="h-2.5 w-[176px]" />
					<Skeleton className="h-2.5 w-[176px]" />
				</div>
				<Skeleton className="hidden h-3 w-[132px] lg:block" />
				<Skeleton className="hidden h-3 w-[120px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function ContainerTable({
	containers,
	sortBy = "saturation",
	sortDir = "desc",
	onSortChange,
	waiting,
	referenceTime,
}: ContainerTableProps) {
	return (
		<DataTable.Root ariaLabel="Containers" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<ContainerSortKey>
					label="Container"
					sortKey="containerName"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					width="w-0 flex-1 min-w-[260px]"
				/>
				<ColumnHead<ContainerSortKey>
					label="Peak saturation"
					sortKey="saturation"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					width="w-[176px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<ContainerSortKey>
					label="CPU"
					sortKey="cpuPct"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[132px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<ContainerSortKey>
					label="Mem of limit"
					sortKey="memoryPct"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[120px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<ContainerSortKey>
					label="Last seen"
					sortKey="lastSeen"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[100px]"
				/>
			</DataTable.Head>
			{containers.length === 0 && <DataTable.Empty>No containers match your filter.</DataTable.Empty>}

			{containers.map((container) => (
				<Link
					key={`${container.hostName}/${container.containerName}`}
					to="/infra/containers/$containerName"
					params={{ containerName: container.containerName }}
					search={container.hostName ? { host: container.hostName } : {}}
					className={ROW_LINK_CLASS}
				>
					<div className="w-0 min-w-[260px] flex-1">
						<div className="flex items-center gap-2">
							<span className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
								{container.containerName}
							</span>
							<HostStatusBadge
								quiet
								lastSeen={container.lastSeen}
								referenceTime={referenceTime}
							/>
						</div>
						<MetaLine
							items={[
								container.imageName && `image ${container.imageName}`,
								container.hostName && `host ${container.hostName}`,
								container.composeProject && `compose ${container.composeProject}`,
							]}
						/>
					</div>
					<div className="hidden w-[176px] md:block">
						<MeterRows
							meters={[
								{ label: "CPU", fraction: container.cpuPctPeak },
								{ label: "MEM", fraction: container.memoryPctPeak },
							]}
						/>
					</div>
					<div className="hidden w-[132px] text-right lg:block">
						<AvgPeak avg={container.cpuPct} peak={container.cpuPctPeak} format={formatPct} />
					</div>
					<div className="hidden w-[120px] text-right lg:block">
						<AvgPeak
							avg={container.memoryPct}
							peak={container.memoryPctPeak}
							format={formatPct}
						/>
					</div>
					<div className="w-[100px] text-right">
						<Tooltip>
							<TooltipTrigger
								render={<span />}
								className="cursor-default font-mono text-[11px] text-muted-foreground"
							>
								{formatRelativeTime(container.lastSeen)}
							</TooltipTrigger>
							<TooltipContent>{container.lastSeen}</TooltipContent>
						</Tooltip>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
