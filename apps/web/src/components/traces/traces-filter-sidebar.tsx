import { Result } from "@/lib/effect-atom"
import { getRouteApi } from "@tanstack/react-router"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	serviceColorMap,
} from "./filter-section"
import { DurationRangeFilter } from "./duration-range-filter"
import type { TracesFacetsResponse } from "@/api/warehouse/traces"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

const routeApi = getRouteApi("/traces/")
type TracesSearchParams = ReturnType<typeof routeApi.useSearch>

function LoadingState() {
	return <FilterSidebarLoading sectionCount={5} />
}

interface TracesFilterSidebarViewProps {
	facetsResult: Result.Result<TracesFacetsResponse, unknown>
	filters: TracesSearchParams
	onFilterChange: <K extends keyof TracesSearchParams>(key: K, value: TracesSearchParams[K]) => void
	onDurationRangeChange: (min: number | undefined, max: number | undefined) => void
	onClearFilters: () => void
}

function TracesFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onDurationRangeChange,
	onClearFilters,
}: TracesFilterSidebarViewProps) {
	const hasActiveFilters =
		(filters.services?.length ?? 0) > 0 ||
		(filters.spanNames?.length ?? 0) > 0 ||
		(filters.deploymentEnvs?.length ?? 0) > 0 ||
		(filters.namespaces?.length ?? 0) > 0 ||
		(filters.httpMethods?.length ?? 0) > 0 ||
		(filters.httpStatusCodes?.length ?? 0) > 0 ||
		filters.hasError !== undefined ||
		filters.minDurationMs !== undefined ||
		filters.maxDurationMs !== undefined ||
		(filters.attributeFilters?.length ?? 0) > 0 ||
		(filters.resourceAttributeFilters?.length ?? 0) > 0 ||
		(filters.excludedServices?.length ?? 0) > 0 ||
		(filters.excludedSpanNames?.length ?? 0) > 0 ||
		(filters.excludedDeploymentEnvs?.length ?? 0) > 0 ||
		(filters.excludedNamespaces?.length ?? 0) > 0 ||
		(filters.excludedHttpMethods?.length ?? 0) > 0 ||
		(filters.excludedHttpStatusCodes?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facetsResponse, result) => {
			const facets = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SingleCheckboxFilter
							title="Has Error"
							checked={filters.hasError ?? false}
							onChange={(checked) => onFilterChange("hasError", checked || undefined)}
							count={facets.errorCount}
						/>

						<SingleCheckboxFilter
							title="Root Traces Only"
							checked={filters.rootOnly ?? true}
							onChange={(checked) => onFilterChange("rootOnly", checked ? undefined : false)}
						/>

						{/* Only meaningful on the grouped trace list — the span-level
						    list (rootOnly off) has no trace structure to judge. */}
						{(filters.rootOnly ?? true) && (
							<SingleCheckboxFilter
								title="Hide Single-Span Noise"
								checked={filters.hideNoise ?? true}
								onChange={(checked) =>
									onFilterChange("hideNoise", checked ? undefined : false)
								}
							/>
						)}

						<FilterSection
							title="Environment"
							options={facets.deploymentEnvs ?? []}
							selected={filters.deploymentEnvs ?? []}
							onChange={(val) => onFilterChange("deploymentEnvs", val)}
							excluded={filters.excludedDeploymentEnvs ?? []}
							onExcludedChange={(val) => onFilterChange("excludedDeploymentEnvs", val)}
						/>

						<SearchableFilterSection
							title="Namespace"
							options={facets.namespaces ?? []}
							selected={filters.namespaces ?? []}
							onChange={(val) => onFilterChange("namespaces", val)}
							excluded={filters.excludedNamespaces ?? []}
							onExcludedChange={(val) => onFilterChange("excludedNamespaces", val)}
						/>

						<SearchableFilterSection
							title="Service"
							options={facets.services ?? []}
							selected={filters.services ?? []}
							onChange={(val) => onFilterChange("services", val)}
							excluded={filters.excludedServices ?? []}
							onExcludedChange={(val) => onFilterChange("excludedServices", val)}
							colorMap={serviceColorMap(facets.services ?? [])}
						/>

						<SearchableFilterSection
							title="Root Span"
							options={facets.spanNames ?? []}
							selected={filters.spanNames ?? []}
							onChange={(val) => onFilterChange("spanNames", val)}
							excluded={filters.excludedSpanNames ?? []}
							onExcludedChange={(val) => onFilterChange("excludedSpanNames", val)}
						/>

						<DurationRangeFilter
							minValue={filters.minDurationMs}
							maxValue={filters.maxDurationMs}
							onRangeChange={onDurationRangeChange}
							durationStats={facets.durationStats}
						/>

						<FilterSection
							title="HTTP Method"
							options={facets.httpMethods ?? []}
							selected={filters.httpMethods ?? []}
							onChange={(val) => onFilterChange("httpMethods", val)}
							excluded={filters.excludedHttpMethods ?? []}
							onExcludedChange={(val) => onFilterChange("excludedHttpMethods", val)}
						/>

						<FilterSection
							title="Status Code"
							options={facets.httpStatusCodes ?? []}
							selected={filters.httpStatusCodes ?? []}
							onChange={(val) => onFilterChange("httpStatusCodes", val)}
							excluded={filters.excludedHttpStatusCodes ?? []}
							onExcludedChange={(val) => onFilterChange("excludedHttpStatusCodes", val)}
						/>
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

/** Connected wrapper that reads filters from TanStack Router and navigates on change. */
interface TracesFilterSidebarProps {
	facetsResult: Result.Result<TracesFacetsResponse, unknown>
}

export function TracesFilterSidebar({ facetsResult }: TracesFilterSidebarProps) {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()

	const onFilterChange = <K extends keyof TracesSearchParams>(key: K, value: TracesSearchParams[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onDurationRangeChange = (min: number | undefined, max: number | undefined) => {
		navigate({
			search: (prev) => ({
				...prev,
				minDurationMs: min,
				maxDurationMs: max,
			}),
			replace: true,
		})
	}

	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
			},
		})
	}

	return (
		<TracesFilterSidebarView
			facetsResult={facetsResult}
			filters={search}
			onFilterChange={onFilterChange}
			onDurationRangeChange={onDurationRangeChange}
			onClearFilters={onClearFilters}
		/>
	)
}
