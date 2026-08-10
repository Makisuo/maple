import { Result } from "@/lib/effect-atom"

import { Separator } from "@maple/ui/components/ui/separator"

import type { WebAnalyticsBreakdowns } from "@/api/warehouse/web-analytics"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
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
import { FILTER_SECTION_LABEL, type AnalyticsFilterKey, type AnalyticsFilters } from "./filters"
import { countryLabel, languageLabel } from "./labels"

interface AnalyticsFilterSidebarProps {
	breakdownsResult: Result.Result<WebAnalyticsBreakdowns, QueryAtomFailure>
	filters: AnalyticsFilters
	onFilterChange: (key: AnalyticsFilterKey, value: string | undefined) => void
	onClearFilters: () => void
}

const toOptions = (rows: ReadonlyArray<{ name: string; count: number }>): ReadonlyArray<FilterOption> =>
	rows.map((row) => ({ name: row.name, count: row.count }))

export function AnalyticsFilterSidebar({
	breakdownsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: AnalyticsFilterSidebarProps) {
	return Result.builder(breakdownsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={6} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((breakdowns, result) => (
			<AnalyticsFilterSidebarView
				breakdowns={breakdowns}
				waiting={result.waiting}
				filters={filters}
				onFilterChange={onFilterChange}
				onClearFilters={onClearFilters}
			/>
		))
		.render()
}

function AnalyticsFilterSidebarView({
	breakdowns,
	waiting,
	filters,
	onFilterChange,
	onClearFilters,
}: {
	breakdowns: WebAnalyticsBreakdowns
	waiting: boolean
	filters: AnalyticsFilters
	onFilterChange: (key: AnalyticsFilterKey, value: string | undefined) => void
	onClearFilters: () => void
}) {
	/**
	 * The shared `FilterSection` is multi-select; these filters are single-valued
	 * (see `./filters`). Adapt rather than fork the section: hand it a 0-or-1
	 * element array, and on change keep whichever value is new. Ticking a second
	 * box therefore *moves* the selection instead of unioning it, which is what a
	 * single-valued filter means.
	 */
	const single = (key: AnalyticsFilterKey) => ({
		selected: filters[key] ? [filters[key]!] : [],
		onChange: (next: string[]) => {
			const current = filters[key]
			onFilterChange(key, next.find((value) => value !== current) ?? undefined)
		},
	})

	const canClear = Object.values(filters).some(Boolean)

	return (
		<FilterSidebarFrame waiting={waiting}>
			<FilterSidebarHeader canClear={canClear} onClear={onClearFilters} />
			<FilterSidebarBody>
				<FilterSection
					title={FILTER_SECTION_LABEL.visitorType}
					options={[
						{ name: "new", count: 0 },
						{ name: "returning", count: 0 },
					]}
					getOptionLabel={(name) => (name === "new" ? "New" : "Returning")}
					{...single("visitorType")}
				/>
				<Separator className="my-1" />
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.host}
					options={toOptions(breakdowns.hosts)}
					{...single("host")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.pagePath}
					options={toOptions(breakdowns.entryPaths)}
					{...single("pagePath")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.referrerHost}
					options={toOptions(breakdowns.referrerHosts)}
					{...single("referrerHost")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.country}
					options={toOptions(breakdowns.countries)}
					getOptionLabel={countryLabel}
					{...single("country")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.deviceType}
					options={toOptions(breakdowns.deviceTypes)}
					{...single("deviceType")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.browserName}
					options={toOptions(breakdowns.browsers)}
					{...single("browserName")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.osName}
					options={toOptions(breakdowns.operatingSystems)}
					{...single("osName")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.language}
					options={toOptions(breakdowns.languages)}
					getOptionLabel={languageLabel}
					{...single("language")}
				/>
				<Separator className="my-1" />
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.utmSource}
					options={toOptions(breakdowns.utmSources)}
					{...single("utmSource")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.utmMedium}
					options={toOptions(breakdowns.utmMediums)}
					{...single("utmMedium")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.utmCampaign}
					options={toOptions(breakdowns.utmCampaigns)}
					{...single("utmCampaign")}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
