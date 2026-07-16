import { useMemo } from "react"
import type { AnomalyIncidentDocument, AnomalySignalType } from "@maple/domain/http"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Label } from "@maple/ui/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { Separator } from "@maple/ui/components/ui/separator"
import { cn } from "@maple/ui/utils"

import { ChevronDownIcon } from "@/components/icons"
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

/** Fixed-vocabulary section where the URL value differs from the display label. */
function LabeledFilterSection<T extends string>({
	title,
	options,
	selected,
	onChange,
}: {
	title: string
	options: ReadonlyArray<{ value: T; label: string; count: number }>
	selected: ReadonlyArray<T>
	onChange: (selected: ReadonlyArray<T>) => void
}) {
	const toggle = (value: T) => {
		onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
	}
	if (options.length === 0) return null
	return (
		<Collapsible defaultOpen>
			<CollapsibleTrigger className="group flex w-full items-center justify-between py-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors">
				<span>{title}</span>
				<ChevronDownIcon
					className={cn("size-4 transition-transform group-data-[panel-open]:rotate-180")}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-2">
					{options.map((option) => (
						<div key={option.value} className="flex items-center gap-2">
							<Checkbox
								id={`${title}-${option.value}`}
								checked={selected.includes(option.value)}
								onCheckedChange={() => toggle(option.value)}
							/>
							<Label
								htmlFor={`${title}-${option.value}`}
								className="flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs text-foreground font-normal"
							>
								<span className="truncate">{option.label}</span>
							</Label>
							<span className="text-xs text-muted-foreground tabular-nums">
								{option.count.toLocaleString()}
							</span>
						</div>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

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
		return {
			severity: byCount(severity),
			signals: byCount(signals),
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
				<LabeledFilterSection
					title="Severity"
					options={facets.severity.map(([value, count]) => ({
						value,
						label: value === "critical" ? "Critical" : "Warning",
						count,
					}))}
					selected={filters.severity ?? []}
					onChange={(val) => onChange("severity", val.length === 0 ? undefined : val)}
				/>
				{facets.severity.length > 0 && <Separator className="my-2" />}
				<LabeledFilterSection
					title="Signal"
					options={facets.signals.map(([value, count]) => ({
						value,
						label: SIGNAL_LABEL[value],
						count,
					}))}
					selected={filters.signals ?? []}
					onChange={(val) => onChange("signals", val.length === 0 ? undefined : val)}
				/>
				{facets.signals.length > 0 && <Separator className="my-2" />}
				{facets.services.length > 0 && (
					<>
						<FilterSection
							title="Service"
							options={facets.services}
							selected={[...(filters.services ?? [])]}
							onChange={(val) => onChange("services", val.length === 0 ? undefined : val)}
							colorMap={serviceColorMap(facets.services)}
						/>
						<Separator className="my-2" />
					</>
				)}
				{facets.envs.length > 0 && (
					<FilterSection
						title="Environment"
						options={facets.envs}
						selected={[...(filters.envs ?? [])]}
						onChange={(val) => onChange("envs", val.length === 0 ? undefined : val)}
					/>
				)}
				{incidents.length === 0 && (
					<p className="text-sm text-muted-foreground py-4">No anomalies in this view</p>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
