import type { Dispatch, SetStateAction } from "react"

import { Card } from "@maple/ui/components/ui/card"
import { Label } from "@maple/ui/components/ui/label"

import { ServiceCombobox } from "@/components/alerts/service-combobox"
import { SectionLabel } from "@/components/alerts/signal-and-threshold-section"
import { GroupByMultiSelect } from "@/components/query-builder/group-by-multi-select"
import type { AutocompleteValuesContextType } from "@/hooks/use-autocomplete-values"
import { useMetricScopedAutocomplete } from "@/hooks/use-metric-scoped-autocomplete"
import type { RuleFormState } from "@/lib/alerts/form-utils"

interface ScopeSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	serviceNameOptions: string[]
	autocompleteValues: AutocompleteValuesContextType
}

/**
 * Choose which services the rule covers. Group-by and Exclude stay mounted at
 * all times — when a specific service is selected they disable themselves and
 * surface a one-line hint, so the form never silently grows or shrinks as the
 * user edits.
 */
export function ScopeSection({ form, onChange, serviceNameOptions, autocompleteValues }: ScopeSectionProps) {
	const hasSpecificServices = form.serviceNames.length > 0
	const queryOwnsGrouping = form.signalType === "builder_query"

	const effectiveDataSource =
		form.signalType === "builder_query"
			? form.queryDataSource
			: form.signalType === "metric"
				? "metrics"
				: "traces"

	// For metric-signal rules, scope group-by suggestions to the selected metric
	// instead of the org-wide metric attribute keys.
	const isMetricSignal = form.signalType === "metric"
	const scopedAutocomplete = useMetricScopedAutocomplete({
		base: autocompleteValues.metrics,
		metricName: isMetricSignal ? form.metricName.trim() || undefined : undefined,
		metricType: isMetricSignal ? form.metricType : undefined,
	})
	const groupByAttributeKeys =
		effectiveDataSource === "metrics"
			? scopedAutocomplete.groupByKeys
			: autocompleteValues[effectiveDataSource]?.attributeKeys

	return (
		<Card className="p-4">
			<SectionLabel>Scope</SectionLabel>

			<div className="mt-3 space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="rule-services" className="text-xs">
						Services
					</Label>
					<ServiceCombobox
						serviceNames={form.serviceNames}
						options={serviceNameOptions}
						onChange={(values) =>
							onChange((c) => ({
								...c,
								serviceNames: values,
								// Clear group/exclude when narrowing to specific services so the
								// disabled fields don't carry stale state into the submitted rule.
								groupBy:
									values.length > 0 && c.signalType !== "builder_query" ? [] : c.groupBy,
								excludeServiceNames: values.length > 0 ? [] : c.excludeServiceNames,
							}))
						}
						placeholder={form.serviceNames.length === 0 ? "All services" : "Add service..."}
					/>
				</div>

				{!queryOwnsGrouping && (
					<div className="space-y-1.5">
						<Label htmlFor="rule-group-by" className="text-xs">
							Group by
						</Label>
						<GroupByMultiSelect
							dataSource={effectiveDataSource}
							value={form.groupBy}
							onChange={(values) => onChange((c) => ({ ...c, groupBy: values }))}
							attributeKeys={groupByAttributeKeys}
							placeholder="service.name"
							className="w-full"
							disabled={hasSpecificServices}
						/>
						{hasSpecificServices && (
							<p className="text-muted-foreground text-[10px] leading-tight">
								Disabled: each selected service is already its own group.
							</p>
						)}
					</div>
				)}

				<div className="space-y-1.5">
					<Label htmlFor="rule-exclude" className="text-xs">
						Exclude services
					</Label>
					<ServiceCombobox
						serviceNames={form.excludeServiceNames}
						options={serviceNameOptions}
						onChange={(values) => onChange((c) => ({ ...c, excludeServiceNames: values }))}
						disabled={hasSpecificServices}
						placeholder={hasSpecificServices ? "—" : "Skip these services"}
					/>
					{hasSpecificServices && (
						<p className="text-muted-foreground text-[10px] leading-tight">
							Disabled: only applies when scoping to all services.
						</p>
					)}
				</div>
			</div>
		</Card>
	)
}
