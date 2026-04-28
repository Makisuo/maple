import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import { ArrowUpDownIcon } from "@/components/icons"
import { HostStatusBadge } from "./status-badge"
import { UsageBar } from "./usage-bar"
import { deriveHostStatus, formatRelative, type HostStatus } from "./format"

export interface PodRow {
	podName: string
	namespace: string
	nodeName: string
	clusterName: string
	environment: string
	deploymentName: string
	statefulsetName: string
	daemonsetName: string
	jobName: string
	qosClass: string
	podUid: string
	computeType: string
	lastSeen: string
	cpuUsage: number
	cpuLimitPct: number
	memoryLimitPct: number
	cpuRequestPct: number
	memoryRequestPct: number
}

type SortKey =
	| "podName"
	| "namespace"
	| "cpuRequestPct"
	| "cpuLimitPct"
	| "cpuUsage"
	| "memoryRequestPct"
	| "memoryLimitPct"
	| "lastSeen"
type SortDir = "asc" | "desc"

const STRIPE_COLOR: Record<HostStatus, string> = {
	active: "bg-[color-mix(in_oklab,var(--severity-info)_75%,transparent)]",
	idle: "bg-border",
	down: "bg-[color-mix(in_oklab,var(--severity-error)_80%,transparent)]",
}

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

function MetaChip({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-[10px] text-muted-foreground/80">{children}</span>
}

function ColumnHead({
	label,
	sortKey,
	currentKey,
	dir,
	onSort,
	align = "left",
	width,
	hidden,
}: {
	label: string
	sortKey?: SortKey
	currentKey?: SortKey
	dir?: SortDir
	onSort?: (k: SortKey) => void
	align?: "left" | "right"
	width: string
	hidden?: string
}) {
	const active = sortKey && currentKey === sortKey
	const sortable = !!sortKey
	return (
		<div
			className={cn(
				"flex items-center text-[11px] font-medium",
				align === "right" && "justify-end",
				width,
				hidden,
			)}
		>
			{sortable ? (
				<button
					type="button"
					onClick={() => sortKey && onSort?.(sortKey)}
					className={cn(
						"inline-flex items-center gap-1 transition-colors",
						active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{label}
					<ArrowUpDownIcon
						size={10}
						className={cn(
							"transition-opacity",
							active ? "opacity-100" : "opacity-40",
							active && dir === "asc" && "rotate-180",
						)}
					/>
				</button>
			) : (
				<span className="text-muted-foreground">{label}</span>
			)}
		</div>
	)
}

export function PodTableLoading() {
	return (
		<div className="border-y border-border/70">
			<div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
				<ColumnHead label="Pod" width="flex-1 min-w-[280px]" />
				<ColumnHead label="CPU req" align="right" width="w-[140px]" hidden="hidden md:flex" />
				<ColumnHead label="CPU limit" align="right" width="w-[140px]" hidden="hidden md:flex" />
				<ColumnHead label="Mem req" align="right" width="w-[140px]" hidden="hidden lg:flex" />
				<ColumnHead label="Mem limit" align="right" width="w-[140px]" hidden="hidden lg:flex" />
				<ColumnHead label="Last seen" align="right" width="w-[100px]" />
			</div>
			{Array.from({ length: 6 }).map((_, i) => (
				<div
					key={i}
					className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
				>
					<div className="flex flex-1 min-w-[280px] gap-3">
						<span className="w-[2px] self-stretch bg-muted/50" />
						<div className="flex-1">
							<Skeleton className="h-4 w-48" />
							<Skeleton className="mt-1.5 h-3 w-40" />
						</div>
					</div>
					<Skeleton className="hidden md:block h-3 w-[140px]" />
					<Skeleton className="hidden md:block h-3 w-[140px]" />
					<Skeleton className="hidden lg:block h-3 w-[140px]" />
					<Skeleton className="hidden lg:block h-3 w-[140px]" />
					<Skeleton className="h-3 w-16" />
				</div>
			))}
		</div>
	)
}

export function PodTable({ pods, waiting, referenceTime }: PodTableProps) {
	const [sortKey, setSortKey] = useState<SortKey>("cpuLimitPct")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

	function handleSort(k: SortKey) {
		if (k === sortKey) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"))
		} else {
			setSortKey(k)
			setSortDir(k === "podName" || k === "namespace" ? "asc" : "desc")
		}
	}

	const sorted = useMemo(() => {
		const copy = [...pods]
		copy.sort((a, b) => {
			const av = a[sortKey]
			const bv = b[sortKey]
			if (typeof av === "number" && typeof bv === "number") {
				return sortDir === "asc" ? av - bv : bv - av
			}
			const as = String(av)
			const bs = String(bv)
			return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
		})
		return copy
	}, [pods, sortKey, sortDir])

	return (
		<div
			className={cn("border-y border-border/70 transition-opacity", waiting && "opacity-60")}
			aria-label="Pods"
		>
			<div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
				<ColumnHead
					label="Pod"
					sortKey="podName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="flex-1 min-w-[280px]"
				/>
				<ColumnHead
					label="CPU req"
					sortKey="cpuRequestPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead
					label="CPU limit"
					sortKey="cpuLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead
					label="Mem req"
					sortKey="memoryRequestPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead
					label="Mem limit"
					sortKey="memoryLimitPct"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[140px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead
					label="Last seen"
					sortKey="lastSeen"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
				/>
			</div>

			{sorted.length === 0 ? (
				<div className="px-4 py-12 text-center text-[12px] text-muted-foreground">
					No pods match your filter.
				</div>
			) : (
				sorted.map((pod) => {
					const workload = workloadOf(pod)
					const status = deriveHostStatus(pod.lastSeen, referenceTime ?? Date.now())
					return (
						<Link
							key={`${pod.namespace}/${pod.podName}`}
							to="/infra/kubernetes/pods/$podName"
							params={{ podName: pod.podName }}
							search={pod.namespace ? { namespace: pod.namespace } : {}}
							className="group flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
						>
							<div className="flex flex-1 min-w-[280px] gap-3">
								<span
									className={cn(
										"w-[2px] self-stretch transition-all",
										STRIPE_COLOR[status],
										"group-hover:w-[3px] group-hover:bg-primary",
									)}
								/>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
											{pod.podName}
										</span>
										<HostStatusBadge
											lastSeen={pod.lastSeen}
											referenceTime={referenceTime}
										/>
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
							</div>
							<div className="hidden md:block w-[140px]">
								<UsageBar fraction={pod.cpuRequestPct} />
							</div>
							<div className="hidden md:block w-[140px]">
								<UsageBar fraction={pod.cpuLimitPct} />
							</div>
							<div className="hidden lg:block w-[140px]">
								<UsageBar fraction={pod.memoryRequestPct} />
							</div>
							<div className="hidden lg:block w-[140px]">
								<UsageBar fraction={pod.memoryLimitPct} />
							</div>
							<div className="w-[100px] text-right">
								<Tooltip>
									<TooltipTrigger
										render={<span />}
										className="cursor-default font-mono text-[11px] text-muted-foreground"
									>
										{formatRelative(pod.lastSeen)}
									</TooltipTrigger>
									<TooltipContent>{pod.lastSeen}</TooltipContent>
								</Tooltip>
							</div>
						</Link>
					)
				})
			)}
		</div>
	)
}
