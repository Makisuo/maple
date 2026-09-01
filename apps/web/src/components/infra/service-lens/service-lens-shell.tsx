import type { ReactNode } from "react"

import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import type { TimeRange } from "@/components/time-range-picker/types"

import { ServiceLensRail } from "./service-lens-rail"
import { useServiceLensRail } from "./use-service-lens-rail"

/**
 * The lens inside the section's shell: the service rail where the other views
 * keep a filter rail, and the same tabs and time control as everything else.
 */

interface ServiceLensShellProps {
	activeService?: string
	startTime: string
	endTime: string
	/** The raw search params, forwarded to the rail's links so time survives a switch. */
	timeSearch: TimeRangeSearch
	onTimeChange: (range: TimeRange, options?: { replace?: boolean }) => void
	children: ReactNode
}

export function ServiceLensShell({
	activeService,
	startTime,
	endTime,
	timeSearch,
	onTimeChange,
	children,
}: ServiceLensShellProps) {
	const rail = useServiceLensRail({ startTime, endTime })

	return (
		<KubernetesShell
			view="services"
			trail={activeService ? [{ label: activeService }] : []}
			timeSearch={timeSearch}
			startTime={startTime}
			endTime={endTime}
			defaultPreset="12h"
			onTimeChange={onTimeChange}
			// Wider than the standard filter rail: these rows carry a service name, a
			// percentage and a pod count, and real service names run long enough
			// that w-64 truncates most of them mid-word.
			filtersWidth="w-72"
			filters={
				<ServiceLensRail
					services={rail.services}
					activeService={activeService}
					unlinkedCount={rail.unlinkedCount}
					loading={rail.loading}
					waiting={rail.waiting}
					timeSearch={timeSearch}
				/>
			}
		>
			{children}
		</KubernetesShell>
	)
}
