import { useMemo } from "react"
import { getRouteApi } from "@tanstack/react-router"

import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { FilterSection, SearchableFilterSection } from "@/components/traces/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { getReleasesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { releasesQueryInput } from "./releases-query-input"
import { cn } from "@maple/ui/lib/utils"

import { RELEASE_HEALTH_DESCRIPTION, RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL } from "./release-health"
import {
	RELEASE_HEALTH_ORDER,
	deriveReleaseImpacts,
	groupReleases,
	isReleaseHealth,
	releaseFacetCounts,
} from "./release-model"

const routeApi = getRouteApi("/releases/")

/**
 * Every facet here is client-side, derived from the same releases atom the
 * table reads — no extra request, and the counts always agree with the rows.
 */
export function ReleasesFilterSidebar() {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()

	const atom = getReleasesResultAtom({ data: releasesQueryInput(search) })
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	const facets = useMemo(
		() =>
			Result.isSuccess(result)
				? releaseFacetCounts(
						groupReleases(deriveReleaseImpacts(result.value.releases, result.value.timeline)),
					)
				: undefined,
		[result],
	)

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
			search: { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset },
		})
	}

	const hasActiveFilters =
		(search.environments?.length ?? 0) > 0 ||
		(search.excludedEnvironments?.length ?? 0) > 0 ||
		(search.services?.length ?? 0) > 0 ||
		search.impact !== undefined

	if (Result.isInitial(result)) return <FilterSidebarLoading sectionCount={3} />
	if (Result.isFailure(result)) return <FilterSidebarError error={result.cause} onRetry={refresh} />
	if (facets === undefined) return <FilterSidebarLoading sectionCount={3} />

	return (
		<FilterSidebarFrame waiting={Result.isSuccess(result) && result.waiting}>
			<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
			<FilterSidebarBody>
				<FilterSection
					title="Health"
					options={RELEASE_HEALTH_ORDER.map((band) => ({ name: band, count: facets.health[band] }))}
					selected={search.impact === undefined ? [] : [search.impact]}
					onChange={(selected) => {
						// Single-select on a multi-select control: the newly ticked value
						// wins; un-ticking the active one clears the filter.
						const next = selected.find((value) => value !== search.impact)
						updateFilter("impact", next !== undefined && isReleaseHealth(next) ? next : undefined)
					}}
					getOptionLabel={(name) => (isReleaseHealth(name) ? RELEASE_HEALTH_LABEL[name] : name)}
					getOptionDescription={(name) =>
						isReleaseHealth(name) ? RELEASE_HEALTH_DESCRIPTION[name] : undefined
					}
					renderOptionIcon={(name) =>
						isReleaseHealth(name) ? (
							<span
								className={cn(
									"inline-block size-2 shrink-0 rounded-full",
									RELEASE_HEALTH_DOT_CLASS[name],
								)}
							/>
						) : null
					}
				/>

				<FilterSection
					title="Environment"
					options={facets.environments}
					selected={search.environments ?? []}
					onChange={(value) => updateFilter("environments", value)}
					excluded={search.excludedEnvironments ?? []}
					onExcludedChange={(value) => updateFilter("excludedEnvironments", value)}
				/>

				<SearchableFilterSection
					title="Service"
					options={facets.services}
					selected={search.services ?? []}
					onChange={(value) => updateFilter("services", value)}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
