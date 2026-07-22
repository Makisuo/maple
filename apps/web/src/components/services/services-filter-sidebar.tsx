import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { FilterSection } from "@/components/traces/filter-section"
import { Route } from "@/routes/services/index"
import { Separator } from "@maple/ui/components/ui/separator"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	isServiceHealth,
	useServiceHealthSummary,
} from "@/components/services/use-service-health-summary"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
	return <FilterSidebarLoading sectionCount={2} />
}

export function ServicesFilterSidebar() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const facetsAtom = getServicesFacetsResultAtom({
		data: {
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
		},
	})
	const facetsResult = useRefreshableAtomValue(facetsAtom)
	const refreshFacets = useAtomRefresh(facetsAtom)

	// Client-side facet: derived from the same cached overview/incident/anomaly
	// atoms the table subscribes to — no extra requests, counts always agree
	// with the table's health badges.
	const healthSummary = useServiceHealthSummary({
		startTime: effectiveStartTime,
		endTime: effectiveEndTime,
		environments: search.environments,
		commitShas: search.commitShas,
	})

	const updateFilter = <K extends keyof typeof search>(key: K, value: (typeof search)[K]) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
	}

	const hasActiveFilters =
		(search.environments?.length ?? 0) > 0 ||
		(search.commitShas?.length ?? 0) > 0 ||
		search.health !== undefined

	return Result.builder(facetsResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <FilterSidebarError error={error} onRetry={refreshFacets} />)
		.onSuccess((facetsResponse, result) => {
			const facets = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						{healthSummary !== undefined && (
							<>
								<FilterSection
									title="Health"
									options={(["unhealthy", "degraded", "healthy"] as const).map(
										(level) => ({
											name: level,
											count: healthSummary.counts[level],
										}),
									)}
									selected={search.health === undefined ? [] : [search.health]}
									onChange={(selected) => {
										// Single-select semantics on a multi-select control: the
										// newly toggled value wins; re-unchecking clears the filter.
										const next = selected.find((value) => value !== search.health)
										updateFilter(
											"health",
											next !== undefined && isServiceHealth(next)
												? next
												: undefined,
										)
									}}
								/>
								<Separator className="my-2" />
							</>
						)}

						{(facets.environments.length ?? 0) > 0 && (
							<>
								<FilterSection
									title="Environment"
									options={facets.environments}
									selected={search.environments ?? []}
									onChange={(val) => updateFilter("environments", val)}
								/>
								<Separator className="my-2" />
							</>
						)}

						{(facets.commitShas.length ?? 0) > 0 && (
							<FilterSection
								title="Commit SHA"
								options={facets.commitShas}
								selected={search.commitShas ?? []}
								onChange={(val) => updateFilter("commitShas", val)}
							/>
						)}

						{facets.environments.length === 0 && facets.commitShas.length === 0 && (
							<p className="text-sm text-muted-foreground py-4">No filter options available</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
