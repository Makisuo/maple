import type { ReactNode } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

import { ServiceLensRail } from "./service-lens-rail"
import { useServiceLensRail } from "./use-service-lens-rail"

/**
 * The chrome both lens routes share: breadcrumbs, the rail, and ONE time
 * control.
 *
 * The time range lives in the URL and is read by `TimeRangeHeaderControls` —
 * the same control the list pages use — so switching services in the rail keeps
 * your window. The rest of the Kubernetes section still hides a local `Select`
 * inside each detail page, which is why clicking into a pod there silently
 * resets you to the last hour.
 */

interface ServiceLensShellProps {
	activeService?: string
	startTime: string
	endTime: string
	/** The raw search params, forwarded to the rail's links so time survives a switch. */
	timeSearch: Record<string, unknown>
	timePreset?: string
	onTimeChange: (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => void
	children: ReactNode
}

export function ServiceLensShell({
	activeService,
	startTime,
	endTime,
	timeSearch,
	timePreset,
	onTimeChange,
	children,
}: ServiceLensShellProps) {
	const rail = useServiceLensRail({ startTime, endTime })

	return (
		<PageRefreshProvider timePreset={timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Kubernetes" },
						activeService ? { label: "Services", href: "/infra/kubernetes/services" } : null,
						{ label: activeService ?? "Services" },
					].filter((item) => item !== null)}
				/>
				<DashboardLayout.Body>
					{/* Wider than the standard filter rail: these rows carry a service
					    name, a percentage and a pod count, and real service names run
					    long enough that w-64 truncates most of them mid-word. */}
					<DashboardLayout.Filters width="w-72">
						<ServiceLensRail
							services={rail.services}
							activeService={activeService}
							unlinkedCount={rail.unlinkedCount}
							loading={rail.loading}
							waiting={rail.waiting}
							timeSearch={timeSearch}
						/>
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={startTime}
									endTime={endTime}
									presetValue={timePreset}
									onTimeChange={onTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
