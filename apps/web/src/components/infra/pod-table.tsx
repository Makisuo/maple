import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import type { ListPodsResponse } from "@maple/domain/http"
import type { PodSortKey, SortDirection } from "@/api/warehouse/infra"

import { HostStatusBadge } from "./status-badge"
import { ColumnHead, DataTable, MetaChip, ROW_LINK_CLASS } from "./primitives/data-table"
import { severityLevel } from "./format"
import { BAR_FILL, BAR_VALUE_TONE } from "./severity-tokens"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

export type PodRow = ListPodsResponse["data"][number]

interface PodTableProps {
	pods: ReadonlyArray<PodRow>
	/**
	 * Sorting is server-side: the list is paged, so sorting the page in the
	 * browser would only ever reorder the rows that already came back — which is
	 * how "worst CPU" used to mean "worst of the 200 most recently seen".
	 *
	 * Omit `onSortChange` for embedded lists (pods-on-a-node, pods-in-a-workload)
	 * that just render the server's worst-first order without their own controls.
	 */
	sortBy?: PodSortKey
	sortDir?: SortDirection
	onSortChange?: (key: PodSortKey) => void
	waiting?: boolean
	referenceTime?: string
}

function workloadOf(pod: PodRow): { kind: string; name: string } | null {
	if (pod.deploymentName) return { kind: "deploy", name: pod.deploymentName }
	if (pod.statefulsetName) return { kind: "sts", name: pod.statefulsetName }
	if (pod.daemonsetName) return { kind: "ds", name: pod.daemonsetName }
	if (pod.jobName) return { kind: "job", name: pod.jobName }
	return null
}

const formatPct = (fraction: number) => (Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "—")

/** Cores read at very different magnitudes across a fleet; keep them comparable. */
const formatCores = (cores: number) => {
	if (!Number.isFinite(cores) || cores === 0) return "0"
	if (cores >= 10) return cores.toFixed(0)
	if (cores >= 1) return cores.toFixed(2)
	return cores.toFixed(3)
}

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

function MiniBar({ label, fraction }: { label: string; fraction: number }) {
	const level = severityLevel(fraction)
	const width = Math.min(Math.max(fraction, 0), 1) * 100
	return (
		<div className="flex items-center gap-1.5">
			<span className="w-6 shrink-0 font-mono text-[9px] text-muted-foreground">{label}</span>
			<div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
				<div className={cn("h-full rounded-full", BAR_FILL[level])} style={{ width: `${width}%` }} />
			</div>
			<span
				className={cn(
					"w-8 shrink-0 text-right font-mono text-[10px] tabular-nums",
					BAR_VALUE_TONE[level],
				)}
			>
				{formatPct(fraction)}
			</span>
		</div>
	)
}

export function PodTableLoading() {
	return (
		<DataTable.Root ariaLabel="Pods">
			<DataTable.Head>
				<ColumnHead label="Pod" width="w-0 flex-1 min-w-[260px]" />
				<ColumnHead label="Peak saturation" width="w-[176px]" hidden="hidden md:flex" />
				<ColumnHead label="CPU cores" align="right" width="w-[132px]" hidden="hidden lg:flex" />
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

export function PodTable({
	pods,
	sortBy = "saturation",
	sortDir = "desc",
	onSortChange,
	waiting,
	referenceTime,
}: PodTableProps) {
	return (
		<DataTable.Root ariaLabel="Pods" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<PodSortKey>
					label="Pod"
					sortKey="podName"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					width="w-0 flex-1 min-w-[260px]"
				/>
				<ColumnHead<PodSortKey>
					label="Peak saturation"
					sortKey="saturation"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					width="w-[176px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<PodSortKey>
					label="CPU cores"
					sortKey="cpuUsage"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[132px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<PodSortKey>
					label="Mem of limit"
					sortKey="memoryLimitPct"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[120px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<PodSortKey>
					label="Last seen"
					sortKey="lastSeen"
					currentKey={sortBy}
					dir={sortDir}
					onSort={onSortChange}
					align="right"
					width="w-[100px]"
				/>
			</DataTable.Head>
			{pods.length === 0 && <DataTable.Empty>No pods match your filter.</DataTable.Empty>}

			{pods.map((pod) => {
				const workload = workloadOf(pod)
				return (
					<Link
						key={`${pod.namespace}/${pod.podName}`}
						to="/infra/kubernetes/pods/$podName"
						params={{ podName: pod.podName }}
						search={pod.namespace ? { namespace: pod.namespace } : {}}
						className={ROW_LINK_CLASS}
					>
						<div className="w-0 min-w-[260px] flex-1">
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
						<div className="hidden w-[176px] space-y-1 md:block">
							<MiniBar label="CPU" fraction={pod.cpuLimitPctPeak} />
							<MiniBar label="MEM" fraction={pod.memoryLimitPctPeak} />
						</div>
						<div className="hidden w-[132px] text-right lg:block">
							<AvgPeak avg={pod.cpuUsage} peak={pod.cpuUsagePeak} format={formatCores} />
						</div>
						<div className="hidden w-[120px] text-right lg:block">
							<AvgPeak
								avg={pod.memoryLimitPct}
								peak={pod.memoryLimitPctPeak}
								format={formatPct}
							/>
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
