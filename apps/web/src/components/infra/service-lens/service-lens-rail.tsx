import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"
import { ServiceDot } from "@maple/ui/components/service-dot"

import { severityLevel } from "@/components/infra/format"
import { BAR_VALUE_TONE } from "@/components/infra/severity-tokens"

/**
 * The lens's spine: the services that actually run on this cluster.
 *
 * This replaces the filter sidebar the other Kubernetes pages carry. A filter
 * rail assumes you arrived wanting to narrow a fleet; this page assumes you
 * arrived with a service in mind, so the rail is a switcher, not a filter.
 */

export interface RailService {
	serviceName: string
	podCount: number
	/**
	 * Average CPU-of-limit across the service's pods over the window, as the
	 * service↔workload join reports it. Average, not peak: the join aggregates
	 * per workload, and calling an average a peak in the column head is how a
	 * number starts lying.
	 */
	avgCpuLimitUtilization: number | null
}

interface ServiceLensRailProps {
	services: ReadonlyArray<RailService>
	activeService?: string
	/** Services with spans but no k8s workload — counted, not listed. */
	unlinkedCount?: number
	loading?: boolean
	waiting?: boolean
	timeSearch: Record<string, unknown>
}

export function ServiceLensRail({
	services,
	activeService,
	unlinkedCount,
	loading,
	waiting,
	timeSearch,
}: ServiceLensRailProps) {
	return (
		<div className={cn("flex h-full flex-col gap-0.5 p-3", waiting && "opacity-60")}>
			<div className="px-2 pb-2.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
				Services on this cluster
			</div>

			{loading ? (
				<RailLoading />
			) : services.length === 0 ? (
				<p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
					No service resolves to a Kubernetes workload in this window.
				</p>
			) : (
				services.map((service) => (
					<RailRow
						key={service.serviceName}
						service={service}
						active={service.serviceName === activeService}
						timeSearch={timeSearch}
					/>
				))
			)}

			{unlinkedCount != null && unlinkedCount > 0 && (
				<div className="mt-auto space-y-1.5 border-t px-2 pb-1 pt-3.5">
					<div className="text-[11px] text-foreground">
						{unlinkedCount} {unlinkedCount === 1 ? "service" : "services"} not linked
					</div>
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						Their spans carry no workload identity, so the lens can't reach their pods.{" "}
						<Link
							to="/infra/kubernetes/pods"
							search={timeSearch}
							className="text-primary hover:underline"
						>
							Browse pods directly
						</Link>
						.
					</p>
				</div>
			)}
		</div>
	)
}

function RailRow({
	service,
	active,
	timeSearch,
}: {
	service: RailService
	active: boolean
	timeSearch: Record<string, unknown>
}) {
	const utilization = service.avgCpuLimitUtilization
	// `severityLevel` expects a fraction and returns the tone the pod table
	// already uses, so a service reads the same as its worst row.
	const tone = utilization == null ? undefined : BAR_VALUE_TONE[severityLevel(utilization)]

	return (
		<Link
			to="/infra/kubernetes/services/$serviceName"
			params={{ serviceName: service.serviceName }}
			search={timeSearch}
			className={cn(
				"flex h-[34px] items-center gap-2.5 rounded-md px-2 transition-colors",
				active ? "bg-accent" : "hover:bg-accent/50",
			)}
		>
			<ServiceDot serviceName={service.serviceName} className="size-1.5" />
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-mono text-[12px]",
					active ? "text-foreground" : "text-muted-foreground",
				)}
				title={service.serviceName}
			>
				{service.serviceName}
			</span>
			<span className={cn("w-[38px] shrink-0 text-right font-mono text-[11px] tabular-nums", tone)}>
				{utilization == null ? "—" : formatPercent(utilization)}
			</span>
			<span className="w-[22px] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
				{service.podCount}
			</span>
		</Link>
	)
}

function RailLoading() {
	return (
		<div className="space-y-1.5 px-2 pt-1">
			{Array.from({ length: 6 }, (_, i) => (
				<Skeleton key={i} className="h-[22px] w-full" />
			))}
		</div>
	)
}
