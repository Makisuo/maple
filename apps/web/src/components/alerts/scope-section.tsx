import type { Dispatch, SetStateAction } from "react"

import { Card } from "@maple/ui/components/ui/card"
import { Label } from "@maple/ui/components/ui/label"

import { EnvironmentCombobox, ServiceCombobox } from "@/components/alerts/service-combobox"
import { GroupByMultiSelect } from "@/components/query-builder/group-by-multi-select"
import { SectionHeader } from "@/components/layout/section-header"
import type { AutocompleteValuesContextType } from "@/hooks/use-autocomplete-values"
import type { RuleFormState } from "@/lib/alerts/form-utils"

interface ScopeSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	serviceNameOptions: string[]
	environmentOptions: string[]
	autocompleteValues: AutocompleteValuesContextType
}

/**
 * Choose which services and environments the rule covers. Group-by and Exclude
 * stay mounted at all times — when a specific service is selected they disable
 * themselves and surface a one-line hint, so the form never silently grows or
 * shrinks as the user edits.
 */
export function ScopeSection({
	form,
	onChange,
	serviceNameOptions,
	environmentOptions,
	autocompleteValues,
}: ScopeSectionProps) {
	const hasSpecificServices = form.serviceNames.length > 0
	const queryOwnsGrouping = form.signalType === "builder_query"

	const effectiveDataSource = form.signalType === "builder_query" ? form.queryDataSource : "traces"

	const groupByAttributeKeys = autocompleteValues[effectiveDataSource]?.attributeKeys

	return (
		<Card className="p-4">
			<SectionHeader id="rule-scope-heading" label="Scope" />

			<div className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="rule-services">Services</Label>
					<ServiceCombobox
						id="rule-services"
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

				<div className="space-y-1.5">
					<Label htmlFor="rule-environments">Environments</Label>
					<EnvironmentCombobox
						id="rule-environments"
						environments={form.environments}
						options={environmentOptions}
						onChange={(values) => onChange((c) => ({ ...c, environments: values }))}
					/>
					<p className="text-muted-foreground text-xs">
						Leave empty to evaluate across every environment.
					</p>
				</div>

				{!queryOwnsGrouping && (
					<div className="space-y-1.5">
						<Label htmlFor="rule-group-by">Group by</Label>
						<GroupByMultiSelect
							id="rule-group-by"
							dataSource={effectiveDataSource}
							value={form.groupBy}
							onChange={(values) => onChange((c) => ({ ...c, groupBy: values }))}
							attributeKeys={groupByAttributeKeys}
							placeholder="service.name"
							className="w-full"
							disabled={hasSpecificServices}
						/>
						{hasSpecificServices && (
							<p className="text-muted-foreground text-xs">
								Disabled: each selected service is already its own group.
							</p>
						)}
					</div>
				)}

				<div className="space-y-1.5">
					<Label htmlFor="rule-exclude">Exclude services</Label>
					<ServiceCombobox
						id="rule-exclude"
						serviceNames={form.excludeServiceNames}
						options={serviceNameOptions}
						onChange={(values) => onChange((c) => ({ ...c, excludeServiceNames: values }))}
						disabled={hasSpecificServices}
						placeholder={hasSpecificServices ? "—" : "Skip these services"}
					/>
					{hasSpecificServices && (
						<p className="text-muted-foreground text-xs">
							Disabled: only applies when scoping to all services.
						</p>
					)}
				</div>
			</div>
		</Card>
	)
}
