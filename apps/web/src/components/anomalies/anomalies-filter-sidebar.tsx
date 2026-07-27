import { useMemo } from "react"
import type { AnomalyIncidentDocument, AnomalySignalType } from "@maple/domain/http"

import { FilterSection, serviceColorMap } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@/components/filters/filter-sidebar"
import { SIGNAL_LABEL } from "./anomaly-format"

export interface AnomalyFilters {
	severity?: ReadonlyArray<"warning" | "critical">
	signals?: ReadonlyArray<AnomalySignalType>
	services?: ReadonlyArray<string>
	envs?: ReadonlyArray<string>
}

const SEVERITY_LABEL = { critical: "Critical", warning: "Warning" } as const

export function AnomaliesFilterSidebar({
	incidents,
	filters,
	onChange,
	onClear,
}: {
	/** Unfiltered incidents for the active status tab — facet counts derive from these. */
	incidents: ReadonlyArray<AnomalyIncidentDocument>
	filters: AnomalyFilters
	onChange: <K extends keyof AnomalyFilters>(key: K, value: AnomalyFilters[K]) => void
	onClear: () => void
}) {
	const facets = useMemo(() => {
		const severity = new Map<"warning" | "critical", number>()
		const signals = new Map<AnomalySignalType, number>()
		const services = new Map<string, number>()
		const envs = new Map<string, number>()
		for (const incident of incidents) {
			severity.set(incident.severity, (severity.get(incident.severity) ?? 0) + 1)
			signals.set(incident.signalType, (signals.get(incident.signalType) ?? 0) + 1)
			services.set(incident.serviceName, (services.get(incident.serviceName) ?? 0) + 1)
			if (incident.deploymentEnv) {
				envs.set(incident.deploymentEnv, (envs.get(incident.deploymentEnv) ?? 0) + 1)
			}
		}
		const byCount = <K,>(map: Map<K, number>) => [...map.entries()].sort((a, b) => b[1] - a[1])
		// Severity and signal are fixed vocabularies whose URL value differs from its display
		// label, so each carries a value→label lookup derived from its own (typed) entries.
		const severityEntries = byCount(severity)
		const signalEntries = byCount(signals)
		return {
			severityEntries,
			signalEntries,
			severity: severityEntries.map(([name, count]) => ({ name, count })),
			severityLabels: Object.fromEntries(
				severityEntries.map(([value]) => [value, SEVERITY_LABEL[value]]),
			),
			signals: signalEntries.map(([name, count]) => ({ name, count })),
			signalLabels: Object.fromEntries(signalEntries.map(([value]) => [value, SIGNAL_LABEL[value]])),
			services: byCount(services).map(([name, count]) => ({ name, count })),
			envs: byCount(envs).map(([name, count]) => ({ name, count })),
		}
	}, [incidents])

	const hasActiveFilters =
		(filters.severity?.length ?? 0) > 0 ||
		(filters.signals?.length ?? 0) > 0 ||
		(filters.services?.length ?? 0) > 0 ||
		(filters.envs?.length ?? 0) > 0

	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClear} />
			<FilterSidebarBody>
				<FilterSection
					title="Severity"
					options={facets.severity}
					getOptionLabel={(name) => facets.severityLabels[name] ?? name}
					selected={filters.severity ?? []}
					// Narrow back to the union by filtering the already-typed entries — no cast.
					onChange={(vals) =>
						onChange(
							"severity",
							vals.length === 0
								? undefined
								: facets.severityEntries.filter(([v]) => vals.includes(v)).map(([v]) => v),
						)
					}
				/>
				<FilterSection
					title="Signal"
					options={facets.signals}
					getOptionLabel={(name) => facets.signalLabels[name] ?? name}
					selected={filters.signals ?? []}
					onChange={(vals) =>
						onChange(
							"signals",
							vals.length === 0
								? undefined
								: facets.signalEntries.filter(([v]) => vals.includes(v)).map(([v]) => v),
						)
					}
				/>
				<FilterSection
					title="Service"
					options={facets.services}
					selected={filters.services ?? []}
					onChange={(val) => onChange("services", val.length === 0 ? undefined : val)}
					colorMap={serviceColorMap(facets.services)}
				/>
				<FilterSection
					title="Environment"
					options={facets.envs}
					selected={filters.envs ?? []}
					onChange={(val) => onChange("envs", val.length === 0 ? undefined : val)}
				/>
				{incidents.length === 0 && (
					<p className="text-sm text-muted-foreground py-4">No anomalies in this view</p>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
