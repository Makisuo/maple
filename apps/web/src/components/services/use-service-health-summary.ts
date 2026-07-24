import React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useAlertIncidentsList } from "@/hooks/use-alerts-list"
import { openAnomalyIncidentsAtom } from "@/lib/services/atoms/anomaly-atoms"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { anomalyAffectsServiceHealth } from "@/components/anomalies/anomaly-format"
import {
	deriveServiceHealthFromCauses,
	type ServiceHealth,
	type ServiceHealthCause,
} from "@/components/dashboard/service-health"
import type { GetServiceOverviewInput } from "@/api/warehouse/services"

export interface ServiceHealthSummary {
	/** Keyed by {@link serviceHealthRowKey} — one entry per (service, environment) row. */
	byRow: Map<string, ServiceHealth>
	counts: Record<ServiceHealth, number>
}

export const serviceHealthRowKey = (serviceName: string, environment: string) =>
	`${serviceName}::${environment}`

const HEALTH_LEVELS: readonly ServiceHealth[] = ["healthy", "degraded", "unhealthy"]

export const isServiceHealth = (value: string): value is ServiceHealth =>
	(HEALTH_LEVELS as readonly string[]).includes(value)

/**
 * Fleet-level health for every (service, environment) row of the services list.
 *
 * Derived purely from data the page already loads — the one-shot service
 * overview, the locally-synced alert-incident collection, and the single
 * open-anomalies call — so subscribing here from several components shares the
 * same cached atoms and costs no extra requests. Alert incidents match by
 * service name only (an incident's groupKey carries no environment), so an
 * alert-caused badge repeats across a service's environment rows; anomalies
 * match per (service, environment).
 */
export function useServiceHealthSummary(input: GetServiceOverviewInput): ServiceHealthSummary | undefined {
	const overviewResult = useAtomValue(getServiceOverviewResultAtom({ data: input }))
	const { result: incidentsResult } = useAlertIncidentsList()
	const anomaliesResult = useAtomValue(openAnomalyIncidentsAtom)

	const overview = Result.isSuccess(overviewResult) ? overviewResult.value : undefined
	const incidents = Result.isSuccess(incidentsResult) ? incidentsResult.value : undefined
	const anomalies = Result.isSuccess(anomaliesResult) ? anomaliesResult.value : undefined

	return React.useMemo(() => {
		if (overview === undefined || incidents === undefined || anomalies === undefined) return undefined

		const alertCausesByService = new Map<string, ServiceHealthCause[]>()
		for (const incident of incidents.incidents) {
			if (incident.status !== "open" || !incident.groupKey) continue
			const causes = alertCausesByService.get(incident.groupKey)
			const cause: ServiceHealthCause = { severity: incident.severity, label: "Alert firing" }
			if (causes) causes.push(cause)
			else alertCausesByService.set(incident.groupKey, [cause])
		}

		const anomalyCausesByRow = new Map<string, ServiceHealthCause[]>()
		for (const incident of anomalies.incidents) {
			if (!anomalyAffectsServiceHealth(incident)) continue
			const key = serviceHealthRowKey(incident.serviceName, incident.deploymentEnv)
			const causes = anomalyCausesByRow.get(key)
			const cause: ServiceHealthCause = { severity: incident.severity, label: "Anomaly" }
			if (causes) causes.push(cause)
			else anomalyCausesByRow.set(key, [cause])
		}

		const byRow = new Map<string, ServiceHealth>()
		const counts: Record<ServiceHealth, number> = { healthy: 0, degraded: 0, unhealthy: 0 }
		for (const service of overview.data) {
			const key = serviceHealthRowKey(service.serviceName, service.environment)
			const health = deriveServiceHealthFromCauses([
				...(alertCausesByService.get(service.serviceName) ?? []),
				...(anomalyCausesByRow.get(key) ?? []),
			])
			byRow.set(key, health)
			counts[health] += 1
		}
		return { byRow, counts }
	}, [overview, incidents, anomalies])
}
