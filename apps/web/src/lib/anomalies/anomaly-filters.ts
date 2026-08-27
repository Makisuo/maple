import type { AnomalyIncidentDocument, AnomalySignalType } from "@maple/domain/http"

export type AnomalySeverity = "warning" | "critical"

export interface AnomalyFilters {
	severity?: ReadonlyArray<AnomalySeverity>
	signals?: ReadonlyArray<AnomalySignalType>
	services?: ReadonlyArray<string>
	envs?: ReadonlyArray<string>
	excludedSeverity?: ReadonlyArray<AnomalySeverity>
	excludedSignals?: ReadonlyArray<AnomalySignalType>
	excludedServices?: ReadonlyArray<string>
	excludedEnvs?: ReadonlyArray<string>
}

/**
 * Anomaly filtering runs in memory — the incident list is already loaded, and the facet counts are
 * derived from it — so both polarities are one predicate rather than a query.
 */
export function matchesAnomalyFilters(
	incident: Pick<AnomalyIncidentDocument, "severity" | "signalType" | "serviceName" | "deploymentEnv">,
	filters: AnomalyFilters,
): boolean {
	const included = <T>(values: ReadonlyArray<T> | undefined, value: T) =>
		values === undefined || values.length === 0 || values.includes(value)
	const notExcluded = <T>(values: ReadonlyArray<T> | undefined, value: T) =>
		values === undefined || !values.includes(value)

	return (
		included(filters.severity, incident.severity) &&
		included(filters.signals, incident.signalType) &&
		included(filters.services, incident.serviceName) &&
		included(filters.envs, incident.deploymentEnv) &&
		notExcluded(filters.excludedSeverity, incident.severity) &&
		notExcluded(filters.excludedSignals, incident.signalType) &&
		notExcluded(filters.excludedServices, incident.serviceName) &&
		notExcluded(filters.excludedEnvs, incident.deploymentEnv)
	)
}

export function hasAnomalyFilters(filters: AnomalyFilters): boolean {
	return Object.values(filters).some((values) => (values?.length ?? 0) > 0)
}

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Severity", include: "severity", exclude: "excludedSeverity" },
	{ label: "Signal", include: "signals", exclude: "excludedSignals" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Environment", include: "envs", exclude: "excludedEnvs" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof AnomalyFilters
	exclude: keyof AnomalyFilters
}>

export interface AnomalyFilterChipDescriptor {
	param: keyof AnomalyFilters
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function anomalyFilterChips(filters: AnomalyFilters): AnomalyFilterChipDescriptor[] {
	const chips: AnomalyFilterChipDescriptor[] = []
	for (const facet of FACETS) {
		const excluded = filters[facet.exclude]
		if (excluded?.length) {
			chips.push({ param: facet.exclude, label: facet.label, values: excluded, negated: true })
		}
	}
	for (const facet of FACETS) {
		const included = filters[facet.include]
		if (included?.length) {
			chips.push({ param: facet.include, label: facet.label, values: included, negated: false })
		}
	}
	return chips
}
