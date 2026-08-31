import { useMemo } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"

import {
	getServiceOverviewResultAtom,
	getServiceWorkloadsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { RailService } from "./service-lens-rail"

/**
 * The rail's contents, in two hops.
 *
 * There is no "list the services running on Kubernetes" query, and adding one
 * would duplicate a join that already exists: the service overview knows every
 * service that emitted spans, and `serviceWorkloads` maps a batch of names to
 * their workloads. The services with a workload are the ones this page can talk
 * about; the rest are counted, so the rail can say what it is not showing
 * rather than silently dropping them.
 *
 * The second hop's atom key is the sorted, de-duplicated service list, so it
 * stays stable across the overview's own refreshes.
 */
export function useServiceLensRail({ startTime, endTime }: { startTime: string; endTime: string }): {
	services: RailService[]
	unlinkedCount: number
	loading: boolean
	waiting: boolean
} {
	const overviewResult = useAtomValue(getServiceOverviewResultAtom({ data: { startTime, endTime } }))

	// The overview is per (service, environment), so one service can appear
	// several times. The join takes names.
	const serviceNames = useMemo(
		() =>
			Result.builder(overviewResult)
				.onSuccess((r) => [...new Set(r.data.map((row) => row.serviceName))].sort())
				.orElse((): string[] => []),
		[overviewResult],
	)

	const workloadsResult = useAtomValue(
		getServiceWorkloadsResultAtom({ data: { services: serviceNames, startTime, endTime } }),
	)

	const services = useMemo(
		() =>
			Result.builder(workloadsResult)
				.onSuccess((r) => {
					// A service can map to more than one workload (a deployment plus a
					// job, say). The rail is a switcher keyed by service, so the rows
					// are folded: pods add up, and utilization takes the worst of them
					// — the rail's job is to surface the one worth clicking.
					const byService = new Map<string, RailService>()
					for (const workload of r.workloads) {
						// Kind "unknown" means the span carried k8s attributes that name
						// no deployment/statefulset/daemonset. The detail page can't
						// query those, so listing them here would offer a row that opens
						// onto "no Kubernetes workload" — they belong in the unlinked
						// count instead.
						if (workload.workloadKind === "unknown") continue
						const existing = byService.get(workload.serviceName)
						if (!existing) {
							byService.set(workload.serviceName, {
								serviceName: workload.serviceName,
								podCount: workload.podCount,
								avgCpuLimitUtilization: workload.avgCpuLimitUtilization,
							})
							continue
						}
						existing.podCount += workload.podCount
						existing.avgCpuLimitUtilization = maxOrNull(
							existing.avgCpuLimitUtilization,
							workload.avgCpuLimitUtilization,
						)
					}
					return [...byService.values()].sort(byUtilizationThenName)
				})
				.orElse((): RailService[] => []),
		[workloadsResult],
	)

	return {
		services,
		// Only once the join has answered. While it is in flight `services` is
		// empty, and the difference is then every service in the org — the rail
		// would flash "42 services not linked" on the way to listing them.
		unlinkedCount: Result.isSuccess(workloadsResult)
			? Math.max(serviceNames.length - services.length, 0)
			: 0,
		loading: Result.isInitial(overviewResult) || Result.isInitial(workloadsResult),
		waiting:
			(Result.isSuccess(overviewResult) && overviewResult.waiting) ||
			(Result.isSuccess(workloadsResult) && workloadsResult.waiting),
	}
}

function maxOrNull(left: number | null, right: number | null): number | null {
	if (left == null) return right
	if (right == null) return left
	return Math.max(left, right)
}

/** Worst first, so the rail's top row is the one worth opening. */
function byUtilizationThenName(left: RailService, right: RailService): number {
	const delta = (right.avgCpuLimitUtilization ?? -1) - (left.avgCpuLimitUtilization ?? -1)
	return delta !== 0 ? delta : left.serviceName.localeCompare(right.serviceName)
}
