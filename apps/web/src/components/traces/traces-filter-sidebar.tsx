import { Result } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	serviceColorMap,
} from "./filter-section"
import { DurationRangeFilter } from "./duration-range-filter"
import { Route } from "@/routes/traces"
import type { TracesFacetsResponse } from "@/api/warehouse/traces"
import type { TracesSearchParams } from "@/routes/traces"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

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
		(filters.resourceAttributeFilters?.length ?? 0) > 0

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

						<FilterSection
							title="Environment"
							options={facets.deploymentEnvs ?? []}
							selected={filters.deploymentEnvs ?? []}
							onChange={(val) => onFilterChange("deploymentEnvs", val)}
						/>

						<SearchableFilterSection
							title="Namespace"
							options={facets.namespaces ?? []}
							selected={filters.namespaces ?? []}
							onChange={(val) => onFilterChange("namespaces", val)}
						/>

						<SearchableFilterSection
							title="Service"
							options={facets.services ?? []}
							selected={filters.services ?? []}
							onChange={(val) => onFilterChange("services", val)}
							colorMap={serviceColorMap(facets.services ?? [])}
						/>

						<SearchableFilterSection
							title="Root Span"
							options={facets.spanNames ?? []}
							selected={filters.spanNames ?? []}
							onChange={(val) => onFilterChange("spanNames", val)}
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
						/>

						<FilterSection
							title="Status Code"
							options={facets.httpStatusCodes ?? []}
							selected={filters.httpStatusCodes ?? []}
							onChange={(val) => onFilterChange("httpStatusCodes", val)}
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
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

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
