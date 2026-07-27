import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { ListPodsResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { UsageBar } from "./usage-bar"
import { ColumnHead, DataTable, MetaChip, ROW_LINK_CLASS, useTableSort } from "./primitives/data-table"
import { formatRelativeTime } from "@maple/ui/time-format"

export type PodRow = ListPodsResponse["data"][number]

type SortKey =
	| "podName"
	| "namespace"
	| "cpuRequestPct"
	| "cpuLimitPct"
	| "cpuUsage"
	| "memoryRequestPct"
	| "memoryLimitPct"
	| "lastSeen"

interface PodTableProps {
	pods: ReadonlyArray<PodRow>
	waiting?: boolean
	referenceTime?: string
}

function workloadOf(pod: PodRow): { kind: string; name: string } | null {
	if (pod.deploymentName) return { kind: "deploy", name: pod.deploymentName }
	if (pod.statefulsetName) return { kind: "sts", name: pod.statefulsetName }
	if (pod.daemonsetName) return { kind: "ds", name: pod.daemonsetName }
	return null
}

export function PodTableLoading() {
	return (
		<DataTable.Root ariaLabel="Pods">
			<DataTable.Head>
				<ColumnHead label="Pod" width="flex-1 min-w-[280px]" />
				<ColumnHead label="CPU req" align="right" width="w-[140px]" hidden="hidden md:flex" />
				<ColumnHead label="CPU limit" align="right" width="w-[140px]" hidden="hidden md:flex" />
				<ColumnHead label="Mem req" align="right" width="w-[140px]" hidden="hidden lg:flex" />
				<ColumnHead label="Mem limit" align="right" width="w-[140px]" hidden="hidden lg:flex" />
				<ColumnHead label="Last seen" align="right" width="w-[100px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={6}>
				<div className="min-w-[280px] flex-1">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="mt-1.5 h-3 w-40" />
				</div>
				<Skeleton className="hidden h-3 w-[140px] md:block" />
				<Skeleton className="hidden h-3 w-[140px] md:block" />
				<Skeleton className="hidden h-3 w-[140px] lg:block" />
				<Skeleton className="hidden h-3 w-[140px] lg:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function PodTable({ pods, waiting, referenceTime }: PodTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<PodRow, SortKey>(pods, {
		initialKey: "cpuLimitPct",
		stringKeys: ["podName", "namespace"],
	})

	return (
		<DataTable.Root ariaLabel="Pods" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<SortKey>
					label="Pod"
					sortKey="podName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="flex-1 min-w-[280px]"
				/>
				<ColumnHead<SortKey>
					label="CPU req"
					sortKey="cpuRequestPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<SortKey>
					label="CPU limit"
					sortKey="cpuLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<SortKey>
					label="Mem req"
					sortKey="memoryRequestPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<SortKey>
					label="Mem limit"
					sortKey="memoryLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
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
			{sorted.length === 0 && <DataTable.Empty>No pods match your filter.</DataTable.Empty>}

			{sorted.map((pod) => {
				const workload = workloadOf(pod)
				return (
					<Link
						key={`${pod.namespace}/${pod.podName}`}
						to="/infra/kubernetes/pods/$podName"
						params={{ podName: pod.podName }}
						search={pod.namespace ? { namespace: pod.namespace } : {}}
						className={ROW_LINK_CLASS}
					>
						<div className="min-w-[280px] flex-1">
							<div className="flex items-center gap-2">
								<span className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
									{pod.podName}
								</span>
								<HostStatusBadge lastSeen={pod.lastSeen} referenceTime={referenceTime} />
							</div>
							<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
								{pod.namespace && <MetaChip>ns {pod.namespace}</MetaChip>}
								{workload && (
									<>
										<span className="text-foreground/20">·</span>
										<MetaChip>
											{workload.kind} {workload.name}
										</MetaChip>
									</>
								)}
								{pod.nodeName && (
									<>
										<span className="text-foreground/20">·</span>
										<MetaChip>node {pod.nodeName}</MetaChip>
									</>
								)}
								{pod.qosClass && (
									<>
										<span className="text-foreground/20">·</span>
										<MetaChip>qos {pod.qosClass}</MetaChip>
									</>
								)}
								{pod.computeType === "fargate" && (
									<span className="font-mono text-[10px] text-[var(--severity-warn)]">
										fargate
									</span>
								)}
							</div>
						</div>
						<div className="hidden w-[140px] md:block">
							<UsageBar fraction={pod.cpuRequestPct} />
						</div>
						<div className="hidden w-[140px] md:block">
							<UsageBar fraction={pod.cpuLimitPct} />
						</div>
						<div className="hidden w-[140px] lg:block">
							<UsageBar fraction={pod.memoryRequestPct} />
						</div>
						<div className="hidden w-[140px] lg:block">
							<UsageBar fraction={pod.memoryLimitPct} />
						</div>
						<div className="w-[100px] text-right">
							<Tooltip>
								<TooltipTrigger
									render={<span />}
									className="cursor-default font-mono text-[11px] text-muted-foreground"
								>
									{formatRelativeTime(pod.lastSeen)}
								</TooltipTrigger>
								<TooltipContent>{pod.lastSeen}</TooltipContent>
							</Tooltip>
						</div>
					</Link>
				)
			})}
		</DataTable.Root>
	)
}
