import { useCallback, useMemo, useState } from "react"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { AnomalyRow } from "./anomaly-row"
import { SEVERITY_TONE } from "./anomaly-format"
import { ServiceDot } from "@maple/ui/components/service-dot"

export type AnomalyGroupKey = "critical" | "warning" | "resolved"

export const ANOMALY_GROUP_ORDER: ReadonlyArray<AnomalyGroupKey> = ["critical", "warning", "resolved"]

const GROUP_LABEL: Record<AnomalyGroupKey, string> = {
	critical: "Critical",
	warning: "Warning",
	resolved: "Resolved",
}

export function anomalyGroupKey(incident: AnomalyIncidentDocument): AnomalyGroupKey {
	if (incident.status !== "open") return "resolved"
	return incident.severity
}

interface ServiceCluster {
	readonly key: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly incidents: AnomalyIncidentDocument[]
}

/**
 * Consecutive same-service runs (the caller sorts the bucket so one event's
 * anomalies sit together). Runs of ≥2 get a service sub-header.
 */
function clusterByService(incidents: ReadonlyArray<AnomalyIncidentDocument>): ServiceCluster[] {
	const clusters: ServiceCluster[] = []
	for (const incident of incidents) {
		const key = `${incident.serviceName}\u0000${incident.deploymentEnv}`
		const last = clusters[clusters.length - 1]
		if (last !== undefined && last.key === key) {
			last.incidents.push(incident)
		} else {
			clusters.push({
				key,
				serviceName: incident.serviceName,
				deploymentEnv: incident.deploymentEnv,
				incidents: [incident],
			})
		}
	}
	return clusters
}

export function AnomalyGroup({
	group,
	incidents,
	focusedId,
	onFocus,
}: {
	group: AnomalyGroupKey
	incidents: ReadonlyArray<AnomalyIncidentDocument>
	focusedId: string | null
	onFocus: (id: string) => void
}) {
	const [isOpen, setIsOpen] = useState(true)
	const toggle = useCallback(() => setIsOpen((prev) => !prev), [])
	const clusters = useMemo(() => clusterByService(incidents), [incidents])

	return (
		<section>
			<button
				type="button"
				onClick={toggle}
				aria-expanded={isOpen}
				aria-controls={`anomaly-group-${group}`}
				className={cn(
					"sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-border/60 bg-muted/40 pr-2 pl-2 text-left outline-none",
					"backdrop-blur supports-[backdrop-filter]:bg-muted/60",
					"hover:bg-muted/60",
				)}
			>
				<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
					{isOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
				</span>
				<span
					aria-hidden
					className={cn("size-2 shrink-0 rounded-full", SEVERITY_TONE[group].accent)}
				/>
				<span className="shrink-0 text-sm font-medium text-foreground">{GROUP_LABEL[group]}</span>
				<span className="text-xs text-muted-foreground tabular-nums">{incidents.length}</span>
			</button>
			{isOpen ? (
				<div id={`anomaly-group-${group}`} role="list" className="divide-y divide-border/40">
					{clusters.map((cluster) => (
						<div key={cluster.key + cluster.incidents[0]!.id}>
							{cluster.incidents.length >= 2 ? (
								<div className="flex h-7 items-center gap-1.5 border-b border-border/40 bg-muted/20 pl-5 text-[11px] text-muted-foreground">
									<ServiceDot serviceName={cluster.serviceName} className="size-1.5" />
									<span className="font-medium text-foreground/80">
										{cluster.serviceName}
									</span>
									{cluster.deploymentEnv ? <span>{cluster.deploymentEnv}</span> : null}
									<span className="tabular-nums">{cluster.incidents.length} anomalies</span>
								</div>
							) : null}
							<div className="divide-y divide-border/40">
								{cluster.incidents.map((incident) => (
									<div role="listitem" key={incident.id}>
										<AnomalyRow
											incident={incident}
											focused={focusedId === incident.id}
											onFocus={onFocus}
										/>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
		</section>
	)
}
