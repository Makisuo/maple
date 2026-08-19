import { getRouteApi } from "@tanstack/react-router"

import { Result } from "@/lib/effect-atom"
import {
	FilterSection,
	SearchableFilterSection,
	type FilterOption,
} from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { vendorLabel } from "./agent-sessions-list"

const routeApi = getRouteApi("/agent-sessions/")

/** A selected value absent from the current window stays checkable (count 0). */
function withSelected(options: FilterOption[], selected?: string): FilterOption[] {
	if (selected && !options.some((o) => o.name === selected)) {
		return [{ name: selected, count: 0 }, ...options]
	}
	return options
}

interface AgentSessionsFilterSidebarProps {
	/**
	 * Distinct sessions per option, aggregated over the whole window rather than
	 * over the page of rows the list returned. Deliberately unfiltered, so
	 * selecting one option leaves the others visible and countable.
	 */
	facetsResult: Result.Result<
		{
			readonly vendors: ReadonlyArray<FilterOption>
			readonly services: ReadonlyArray<FilterOption>
		},
		unknown
	>
}

export function AgentSessionsFilterSidebar({ facetsResult }: AgentSessionsFilterSidebarProps) {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()

	// Single-value params: take the last toggled option (switching values
	// replaces the prior one; unchecking the only one clears it).
	const setSingle = (key: "vendor" | "service", values: string[]) => {
		navigate({ search: (prev) => ({ ...prev, [key]: values.at(-1) ?? undefined }) })
	}

	const clearAllFilters = () => {
		navigate({ search: (prev) => ({ ...prev, vendor: undefined, service: undefined }) })
	}

	const hasActiveFilters = !!search.vendor || !!search.service

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={2} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((value, result) => {
			const vendors = withSelected([...value.vendors], search.vendor)
			const services = withSelected([...value.services], search.service)

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<FilterSection
							title="Framework"
							options={vendors}
							selected={search.vendor ? [search.vendor] : []}
							onChange={(vals) => setSingle("vendor", vals)}
							getOptionLabel={vendorLabel}
						/>

						<SearchableFilterSection
							title="Service"
							options={services}
							selected={search.service ? [search.service] : []}
							onChange={(vals) => setSingle("service", vals)}
						/>

						{vendors.length === 0 && services.length === 0 && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
