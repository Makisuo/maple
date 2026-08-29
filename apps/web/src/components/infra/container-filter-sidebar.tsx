import { Result } from "@/lib/effect-atom"

import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import type { ContainerFacetsResponse } from "@maple/domain/http"

export interface ContainerFilters {
	containerNames?: ReadonlyArray<string>
	hostNames?: ReadonlyArray<string>
	images?: ReadonlyArray<string>
	composeProjects?: ReadonlyArray<string>
	composeServices?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	excludedContainerNames?: ReadonlyArray<string>
	excludedHostNames?: ReadonlyArray<string>
	excludedImages?: ReadonlyArray<string>
	excludedComposeProjects?: ReadonlyArray<string>
	excludedComposeServices?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
}

interface ContainersFilterSidebarViewProps {
	facetsResult: Result.Result<ContainerFacetsResponse, unknown>
	filters: ContainerFilters
	onFilterChange: <K extends keyof ContainerFilters>(key: K, value: ContainerFilters[K]) => void
	onClearFilters: () => void
}

export function ContainersFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: ContainersFilterSidebarViewProps) {
	const hasActiveFilters =
		(filters.containerNames?.length ?? 0) > 0 ||
		(filters.hostNames?.length ?? 0) > 0 ||
		(filters.images?.length ?? 0) > 0 ||
		(filters.composeProjects?.length ?? 0) > 0 ||
		(filters.composeServices?.length ?? 0) > 0 ||
		(filters.environments?.length ?? 0) > 0 ||
		(filters.excludedContainerNames?.length ?? 0) > 0 ||
		(filters.excludedHostNames?.length ?? 0) > 0 ||
		(filters.excludedImages?.length ?? 0) > 0 ||
		(filters.excludedComposeProjects?.length ?? 0) > 0 ||
		(filters.excludedComposeServices?.length ?? 0) > 0 ||
		(filters.excludedEnvironments?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={6} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title="Container"
							options={f.containers}
							selected={filters.containerNames ?? []}
							onChange={(val) => onFilterChange("containerNames", val)}
							excluded={filters.excludedContainerNames ?? []}
							onExcludedChange={(val) => onFilterChange("excludedContainerNames", val)}
							defaultOpen
						/>
						<SearchableFilterSection
							title="Image"
							options={f.images}
							selected={filters.images ?? []}
							onChange={(val) => onFilterChange("images", val)}
							excluded={filters.excludedImages ?? []}
							onExcludedChange={(val) => onFilterChange("excludedImages", val)}
							defaultOpen={false}
						/>
						<SearchableFilterSection
							title="Host"
							options={f.hosts}
							selected={filters.hostNames ?? []}
							onChange={(val) => onFilterChange("hostNames", val)}
							excluded={filters.excludedHostNames ?? []}
							onExcludedChange={(val) => onFilterChange("excludedHostNames", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Compose Project"
							options={f.composeProjects}
							selected={filters.composeProjects ?? []}
							onChange={(val) => onFilterChange("composeProjects", val)}
							excluded={filters.excludedComposeProjects ?? []}
							onExcludedChange={(val) => onFilterChange("excludedComposeProjects", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Compose Service"
							options={f.composeServices}
							selected={filters.composeServices ?? []}
							onChange={(val) => onFilterChange("composeServices", val)}
							excluded={filters.excludedComposeServices ?? []}
							onExcludedChange={(val) => onFilterChange("excludedComposeServices", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Environment"
							options={f.environments}
							selected={filters.environments ?? []}
							onChange={(val) => onFilterChange("environments", val)}
							excluded={filters.excludedEnvironments ?? []}
							onExcludedChange={(val) => onFilterChange("excludedEnvironments", val)}
							defaultOpen={false}
						/>
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
