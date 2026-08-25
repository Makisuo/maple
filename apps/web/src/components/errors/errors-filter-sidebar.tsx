import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { getRouteApi } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { FilterSection, SingleCheckboxFilter, serviceColorMap } from "@/components/traces/filter-section"
import { getErrorsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

const routeApi = getRouteApi("/errors/")

function LoadingState() {
	return <FilterSidebarLoading sectionCount={3} />
}

export function ErrorsFilterSidebar() {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	// Every active filter goes to the facets query, not just the time range: each
	// section drops its own dimension server-side, so ticking `production` narrows
	// the Service and Version counts while Environment still shows its
	// alternatives. Without them the numbers never moved when a box was ticked.
	const facetsAtom = getErrorsFacetsResultAtom({
		data: {
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
			showSpam: search.showSpam,
			rootOnly: search.rootOnly !== false,
			services: search.services ? [...search.services] : undefined,
			deploymentEnvs: search.deploymentEnvs ? [...search.deploymentEnvs] : undefined,
			errorLabels: search.errorTypes ? [...search.errorTypes] : undefined,
			serviceVersions: search.serviceVersions ? [...search.serviceVersions] : undefined,
		},
	})
	const facetsResult = useRefreshableAtomValue(facetsAtom)
	const refreshFacets = useAtomRefresh(facetsAtom)

	const updateFilter = <K extends keyof typeof search>(key: K, value: (typeof search)[K]) => {
		navigate({
			search: (prev) => ({
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
		(search.services?.length ?? 0) > 0 ||
		(search.deploymentEnvs?.length ?? 0) > 0 ||
		(search.errorTypes?.length ?? 0) > 0 ||
		(search.serviceVersions?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <FilterSidebarError error={error} onRetry={refreshFacets} />)
		.onSuccess((facetsResponse, result) => {
			const facets = facetsResponse.data
			const hasFacets =
				(facets.services?.length ?? 0) > 0 ||
				(facets.deploymentEnvs?.length ?? 0) > 0 ||
				(facets.errorTypes?.length ?? 0) > 0 ||
				(facets.serviceVersions?.length ?? 0) > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<SingleCheckboxFilter
							title="All span errors"
							checked={search.rootOnly === false}
							onChange={(checked) => updateFilter("rootOnly", checked ? false : undefined)}
						/>
						<SingleCheckboxFilter
							title="Show scanner noise"
							checked={search.showSpam ?? false}
							onChange={(checked) => updateFilter("showSpam", checked || undefined)}
						/>

						<FilterSection
							title="Environment"
							options={facets.deploymentEnvs ?? []}
							selected={search.deploymentEnvs ?? []}
							onChange={(val) => updateFilter("deploymentEnvs", val)}
						/>

						<FilterSection
							title="Service"
							options={facets.services ?? []}
							selected={search.services ?? []}
							onChange={(val) => updateFilter("services", val)}
							colorMap={serviceColorMap(facets.services ?? [])}
						/>

						<FilterSection
							title="Error Type"
							options={facets.errorTypes ?? []}
							selected={search.errorTypes ?? []}
							onChange={(val) => updateFilter("errorTypes", val)}
						/>

						{/* Which deploy the error was seen on — the fastest way to tell a
						    regression from something that was always broken. */}
						<FilterSection
							title="Version"
							options={facets.serviceVersions ?? []}
							selected={search.serviceVersions ?? []}
							onChange={(val) => updateFilter("serviceVersions", val)}
						/>

						{!hasFacets && (
							<p className="text-sm text-muted-foreground py-4">
								No errors found in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
