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
import { vendorLabel, type AgentSessionRow } from "./agent-sessions-list"

const routeApi = getRouteApi("/agent-sessions/")

/**
 * Facet counts derived client-side from the unfiltered list rows — sessions per
 * vendor and per touched service within the current window. There is no facets
 * warehouse query yet, so the counts (and the option lists) only see what the
 * list's own limit returned; good enough while a window holds tens of sessions,
 * and the seam to replace with a real aggregation when it doesn't.
 */
function facetCounts(
	rows: ReadonlyArray<AgentSessionRow>,
	pick: (row: AgentSessionRow) => ReadonlyArray<string>,
): FilterOption[] {
	const counts = new Map<string, number>()
	for (const row of rows) {
		for (const name of pick(row)) {
			counts.set(name, (counts.get(name) ?? 0) + 1)
		}
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** A selected value absent from the current window stays checkable (count 0). */
function withSelected(options: FilterOption[], selected?: string): FilterOption[] {
	if (selected && !options.some((o) => o.name === selected)) {
		return [{ name: selected, count: 0 }, ...options]
	}
	return options
}

interface AgentSessionsFilterSidebarProps {
	/** The UNFILTERED window's sessions, so option lists survive an active filter. */
	optionsResult: Result.Result<{ readonly data: ReadonlyArray<AgentSessionRow> }, unknown>
}

export function AgentSessionsFilterSidebar({ optionsResult }: AgentSessionsFilterSidebarProps) {
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

	return Result.builder(optionsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={2} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((value, result) => {
			const vendors = withSelected(
				facetCounts(value.data, (row) => [row.vendorId]),
				search.vendor,
			)
			const services = withSelected(
				facetCounts(value.data, (row) => row.serviceNames),
				search.service,
			)

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
