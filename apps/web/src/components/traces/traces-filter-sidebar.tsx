import { Result } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import { FilterSection, SearchableFilterSection, SingleCheckboxFilter } from "./filter-section"
import { DurationRangeFilter } from "./duration-range-filter"
import { Route } from "@/routes/traces"
import { Separator } from "@maple/ui/components/ui/separator"
import type { TracesFacetsResponse } from "@/api/tinybird/traces"
import type { TracesSearchParams } from "@/routes/traces"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
	return <FilterSidebarLoading sectionCount={5} sticky />
}

export interface TracesFilterSidebarViewProps {
	facetsResult: Result.Result<TracesFacetsResponse, unknown>
	filters: TracesSearchParams
	onFilterChange: <K extends keyof TracesSearchParams>(key: K, value: TracesSearchParams[K]) => void
	onClearFilters: () => void
}

export function TracesFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: TracesFilterSidebarViewProps) {
	const hasActiveFilters =
		(filters.services?.length ?? 0) > 0 ||
		(filters.spanNames?.length ?? 0) > 0 ||
		(filters.deploymentEnvs?.length ?? 0) > 0 ||
		(filters.httpMethods?.length ?? 0) > 0 ||
		(filters.httpStatusCodes?.length ?? 0) > 0 ||
		filters.hasError !== undefined ||
		filters.minDurationMs !== undefined ||
		filters.maxDurationMs !== undefined ||
		(filters.attributeFilters?.length ?? 0) > 0 ||
		(filters.resourceAttributeFilters?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <LoadingState />)
		.onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
		.onSuccess((facetsResponse, result) => {
			const facets = facetsResponse.data

			return (
				<FilterSidebarFrame sticky waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<DurationRangeFilter
							minValue={filters.minDurationMs}
							maxValue={filters.maxDurationMs}
							onMinChange={(val) => onFilterChange("minDurationMs", val)}
							onMaxChange={(val) => onFilterChange("maxDurationMs", val)}
							durationStats={facets.durationStats}
						/>

						<Separator className="my-2" />

						<SingleCheckboxFilter
							title="Has Error"
							checked={filters.hasError ?? false}
							onChange={(checked) => onFilterChange("hasError", checked || undefined)}
							count={facets.errorCount}
						/>

						<Separator className="my-2" />

						<SingleCheckboxFilter
							title="Root Traces Only"
							checked={filters.rootOnly ?? true}
							onChange={(checked) => onFilterChange("rootOnly", checked ? undefined : false)}
						/>

						<Separator className="my-2" />

						{(facets.deploymentEnvs?.length ?? 0) > 0 && (
							<>
								<FilterSection
									title="Environment"
									options={facets.deploymentEnvs}
									selected={filters.deploymentEnvs ?? []}
									onChange={(val) => onFilterChange("deploymentEnvs", val)}
								/>
								<Separator className="my-2" />
							</>
						)}

						<SearchableFilterSection
							title="Service"
							options={facets.services ?? []}
							selected={filters.services ?? []}
							onChange={(val) => onFilterChange("services", val)}
						/>

						<Separator className="my-2" />

						<SearchableFilterSection
							title="Root Span"
							options={facets.spanNames ?? []}
							selected={filters.spanNames ?? []}
							onChange={(val) => onFilterChange("spanNames", val)}
						/>

						{(facets.httpMethods?.length ?? 0) > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="HTTP Method"
									options={facets.httpMethods}
									selected={filters.httpMethods ?? []}
									onChange={(val) => onFilterChange("httpMethods", val)}
								/>
							</>
						)}

						{(facets.httpStatusCodes?.length ?? 0) > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Status Code"
									options={facets.httpStatusCodes}
									selected={filters.httpStatusCodes ?? []}
									onChange={(val) => onFilterChange("httpStatusCodes", val)}
								/>
							</>
						)}
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
			onClearFilters={onClearFilters}
		/>
	)
}
