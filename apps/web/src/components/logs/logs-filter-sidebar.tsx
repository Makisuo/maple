import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { useCallback, useState } from "react"
import { getRouteApi } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useDebouncedCallback } from "@maple/ui/hooks/use-debounced-callback"
import { FilterSection, SearchableFilterSection, serviceColorMap } from "@/components/filters/filter-section"
import { getLogsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { PinnedNamespaceNotice } from "@/components/filters/pinned-namespace-notice"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"
import { parseLogSearch } from "@/lib/logs/log-search-query"
import { LogSearchInput } from "./log-search-input"

const routeApi = getRouteApi("/logs/")

function LoadingState() {
	return <FilterSidebarLoading sectionCount={3} />
}

export function LogsFilterSidebar() {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()
	const pinnedNamespace = useGlobalNamespace()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const [searchText, setSearchText] = useState(search.search ?? "")

	const debouncedNavigate = useDebouncedCallback((value: string) => {
		// A pasted trace ID (or full W3C traceparent) becomes the trace filter —
		// body search is ILIKE on the message text, where a 32-hex ID never matches.
		const query = parseLogSearch(value)
		if (query?.kind === "trace") {
			setSearchText("")
			navigate({
				search: (prev) => ({ ...prev, search: undefined, traceId: query.traceId }),
			})
			return
		}
		navigate({
			search: (prev) => ({ ...prev, search: query?.text }),
		})
	}, 300)

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchText(value)
			debouncedNavigate(value)
		},
		[debouncedNavigate],
	)

	const facetsAtom = getLogsFacetsResultAtom({
		data: {
			startTime: effectiveStartTime,
			endTime: effectiveEndTime,
		},
	})
	const facetsResult = useAtomValue(facetsAtom)
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
		setSearchText("")
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
		(search.severities?.length ?? 0) > 0 ||
		(search.deploymentEnvs?.length ?? 0) > 0 ||
		(search.namespaces?.length ?? 0) > 0 ||
		(search.excludedServices?.length ?? 0) > 0 ||
		(search.excludedSeverities?.length ?? 0) > 0 ||
		(search.excludedDeploymentEnvs?.length ?? 0) > 0 ||
		(search.excludedNamespaces?.length ?? 0) > 0 ||
		!!search.search ||
		!!search.traceId

	return Result.builder(facetsResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <FilterSidebarError error={error} onRetry={refreshFacets} />)
		.onSuccess((facetsResponse, result) => {
			const facets = facetsResponse.data
			const hasFacets =
				(facets.services?.length ?? 0) > 0 ||
				(facets.severities?.length ?? 0) > 0 ||
				(facets.deploymentEnvs?.length ?? 0) > 0 ||
				(facets.namespaces?.length ?? 0) > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<LogSearchInput value={searchText} onChange={handleSearchChange} />

						<FilterSection
							title="Severity"
							options={facets.severities ?? []}
							selected={search.severities ?? []}
							onChange={(val) => updateFilter("severities", val)}
							excluded={search.excludedSeverities ?? []}
							onExcludedChange={(val) => updateFilter("excludedSeverities", val)}
							colorMap={SEVERITY_COLORS}
						/>

						<FilterSection
							title="Environment"
							options={facets.deploymentEnvs ?? []}
							selected={search.deploymentEnvs ?? []}
							onChange={(val) => updateFilter("deploymentEnvs", val)}
							excluded={search.excludedDeploymentEnvs ?? []}
							onExcludedChange={(val) => updateFilter("excludedDeploymentEnvs", val)}
						/>

						{pinnedNamespace !== null ? (
							<PinnedNamespaceNotice namespace={pinnedNamespace} />
						) : (
							<SearchableFilterSection
								title="Namespace"
								options={facets.namespaces ?? []}
								selected={search.namespaces ?? []}
								onChange={(val) => updateFilter("namespaces", val)}
								excluded={search.excludedNamespaces ?? []}
								onExcludedChange={(val) => updateFilter("excludedNamespaces", val)}
							/>
						)}

						<SearchableFilterSection
							title="Service"
							options={facets.services ?? []}
							selected={search.services ?? []}
							onChange={(val) => updateFilter("services", val)}
							excluded={search.excludedServices ?? []}
							onExcludedChange={(val) => updateFilter("excludedServices", val)}
							colorMap={serviceColorMap(facets.services ?? [])}
						/>

						{!hasFacets && (
							<p className="text-sm text-muted-foreground py-4">
								No logs found in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
