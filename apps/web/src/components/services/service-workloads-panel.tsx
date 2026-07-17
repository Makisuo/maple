import { useMemo } from "react"
import { cn } from "@maple/ui/utils"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceWorkloadsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import { UsageBar } from "@/components/infra/usage-bar"
import { SectionCard } from "./section-card"

interface ServiceWorkloadsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
}

const KIND_LABEL: Record<ServiceWorkload["workloadKind"], string> = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
	unknown: "Workload",
}

/**
 * Kubernetes footprint for this service: the workload(s) it runs as, pod count,
 * and average CPU/memory limit utilization over the window. Workload identity
 * comes from span resource attributes (env-agnostic). Quiet — renders nothing
 * while loading, on error, or when the service carries no k8s context.
 */
export function ServiceWorkloadsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
}: ServiceWorkloadsPanelProps) {
	const result = useRetainedRefreshableResultValue(
		getServiceWorkloadsResultAtom({
			data: {
				services: [serviceName],
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
			},
		}),
	)

	const workloads = useMemo<ServiceWorkload[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.workloads])
				.orElse(() => []),
		[result],
	)

	if (workloads.length === 0) return null

	const isWaiting = Result.isSuccess(result) && result.waiting

	return (
		<SectionCard title="Kubernetes" className={cn("transition-opacity", isWaiting && "opacity-60")}>
			<ul className="divide-y">
				{workloads.map((workload) => (
					<li
						key={`${workload.workloadKind}:${workload.namespace}:${workload.workloadName}`}
						className="flex flex-col gap-1.5 px-4 py-2.5"
					>
						<div className="flex items-center justify-between gap-3">
							<div className="flex min-w-0 flex-col leading-tight">
								<span className="truncate font-mono text-[12.5px] text-foreground">
									{workload.workloadName}
								</span>
								<span className="truncate text-[10px] text-muted-foreground/60">
									{KIND_LABEL[workload.workloadKind]} · {workload.namespace}
									{workload.clusterName ? ` · ${workload.clusterName}` : ""}
								</span>
							</div>
							<span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">
								{workload.podCount} {workload.podCount === 1 ? "pod" : "pods"}
							</span>
						</div>
						{(workload.avgCpuLimitUtilization != null ||
							workload.avgMemoryLimitUtilization != null) && (
							<div className="grid grid-cols-2 gap-4">
								{workload.avgCpuLimitUtilization != null && (
									<div className="flex items-center gap-2">
										<span className="w-7 text-[10px] uppercase tracking-wider text-muted-foreground/60">
											cpu
										</span>
										<UsageBar fraction={workload.avgCpuLimitUtilization} className="flex-1" />
									</div>
								)}
								{workload.avgMemoryLimitUtilization != null && (
									<div className="flex items-center gap-2">
										<span className="w-7 text-[10px] uppercase tracking-wider text-muted-foreground/60">
											mem
										</span>
										<UsageBar fraction={workload.avgMemoryLimitUtilization} className="flex-1" />
									</div>
								)}
							</div>
						)}
					</li>
				))}
			</ul>
		</SectionCard>
	)
}
