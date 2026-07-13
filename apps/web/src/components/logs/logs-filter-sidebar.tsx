import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { useCallback, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { XmarkIcon, MagnifierIcon } from "@/components/icons"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import { Route } from "@/routes/logs"
import { Separator } from "@maple/ui/components/ui/separator"
import { Kbd } from "@maple/ui/components/ui/kbd"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { getLogsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"

function LoadingState() {
	return <FilterSidebarLoading sectionCount={3} />
}

export function LogsFilterSidebar() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const [searchText, setSearchText] = useState(search.search ?? "")
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchText(value)
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				const trimmed = value.trim() || undefined
				navigate({
					search: (prev) => ({ ...prev, search: trimmed }),
				})
			}, 300)
		},
		[navigate],
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
		!!search.search

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
						<div className="pb-3">
							<span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
								Search
							</span>
							<InputGroup className="mt-2">
								<InputGroupAddon>
									<MagnifierIcon />
								</InputGroupAddon>
								<InputGroupInput
									size="sm"
									value={searchText}
									onChange={(e) => handleSearchChange(e.target.value)}
									placeholder="Search log messages..."
									data-shortcut-focus="search"
								/>
								{!searchText && (
									<InputGroupAddon align="inline-end">
										<Kbd>/</Kbd>
									</InputGroupAddon>
								)}
								{searchText && (
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											aria-label="Clear search"
											onClick={() => handleSearchChange("")}
										>
											<XmarkIcon />
										</InputGroupButton>
									</InputGroupAddon>
								)}
							</InputGroup>
						</div>
						<Separator className="my-2" />

						{(facets.severities?.length ?? 0) > 0 && (
							<>
								<FilterSection
									title="Severity"
									options={facets.severities}
									selected={search.severities ?? []}
									onChange={(val) => updateFilter("severities", val)}
									colorMap={SEVERITY_COLORS}
								/>
								<Separator className="my-2" />
							</>
						)}

						{(facets.deploymentEnvs?.length ?? 0) > 0 && (
							<>
								<FilterSection
									title="Environment"
									options={facets.deploymentEnvs}
									selected={search.deploymentEnvs ?? []}
									onChange={(val) => updateFilter("deploymentEnvs", val)}
								/>
								<Separator className="my-2" />
							</>
						)}

						{(facets.namespaces?.length ?? 0) > 0 && (
							<>
								<SearchableFilterSection
									title="Namespace"
									options={facets.namespaces}
									selected={search.namespaces ?? []}
									onChange={(val) => updateFilter("namespaces", val)}
								/>
								<Separator className="my-2" />
							</>
						)}

						{(facets.services?.length ?? 0) > 0 && (
							<SearchableFilterSection
								title="Service"
								options={facets.services}
								selected={search.services ?? []}
								onChange={(val) => updateFilter("services", val)}
							/>
						)}

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
