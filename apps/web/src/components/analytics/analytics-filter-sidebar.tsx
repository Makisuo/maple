import { Result } from "@/lib/effect-atom"

import { Separator } from "@maple/ui/components/ui/separator"
import { cn } from "@maple/ui/lib/utils"

import type { WebAnalyticsBreakdowns, WebAnalyticsEvent } from "@/api/warehouse/web-analytics"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import {
	FILTER_SECTION_LABEL as FILTER_SECTION_LABEL_TEXT,
	type AnalyticsFilterKey,
	type AnalyticsFilters,
} from "./filters"
import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { countryLabel, languageLabel, referrerLabel, utmLabel } from "./labels"
import { Favicon, isHostLike } from "./row-icon"
import { ArrowThroughLineRightIcon } from "@/components/icons"
import { browserIconFor, deviceIconFor } from "@/components/replays/session-icons"

interface AnalyticsFilterSidebarProps {
	breakdownsResult: Result.Result<WebAnalyticsBreakdowns, QueryAtomFailure>
	eventsResult: Result.Result<{ data: ReadonlyArray<WebAnalyticsEvent> }, QueryAtomFailure>
	filters: AnalyticsFilters
	onFilterChange: (key: AnalyticsFilterKey, value: string | undefined) => void
	onClearFilters: () => void
}

const toOptions = (rows: ReadonlyArray<{ name: string; count: number }>): ReadonlyArray<FilterOption> =>
	rows.map((row) => ({ name: row.name, count: row.count }))

/**
 * Sized to the section's `getOptionIcon` slot (3.5) rather than the breakdown
 * panel's (4), so a favicon sits at the same height as the browser and device
 * marks below it.
 */
const hostIcon = (name: string) => <Favicon host={name} className="size-3.5" />

/** The referrer list's direct-traffic row gets the same mark as its breakdown row. */
const referrerIcon = (name: string) =>
	name === WEB_ANALYTICS_UNSET ? (
		<ArrowThroughLineRightIcon className="size-3.5 shrink-0 text-foreground" />
	) : (
		hostIcon(name)
	)

/** `utm_source` is free text — only give it a favicon when it is actually a domain. */
const utmSourceIcon = (name: string) => (isHostLike(name) ? hostIcon(name) : null)

export function AnalyticsFilterSidebar({
	breakdownsResult,
	eventsResult,
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
				// Decorative beside the breakdowns: a slow or failed events query
				// drops the Event section rather than blanking the whole sidebar.
				events={Result.builder(eventsResult)
					.onSuccess((rows) => rows.data)
					.orElse(() => [])}
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
	events,
	waiting,
	filters,
	onFilterChange,
	onClearFilters,
}: {
	breakdowns: WebAnalyticsBreakdowns
	events: ReadonlyArray<WebAnalyticsEvent>
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
				{/* Grouped into the same four themes the breakdown cards use — content,
				    acquisition, audience, technology — and ordered within each group by how
				    often you actually slice by it. Interleaving them (Country between
				    Referrer and Device, UTM stranded at the bottom) is what made the rail
				    read as unsorted. Separators mark the group boundaries. */}
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.host}
					options={toOptions(breakdowns.hosts)}
					renderOptionIcon={hostIcon}
					{...single("host")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.pagePath}
					options={toOptions(breakdowns.entryPaths)}
					{...single("pagePath")}
				/>
				{/* Counts are sessions that fired the event, matching every other count
				    in this rail; firings live on the card. Hidden outright when nothing
				    is tracked — an empty "Event" section would read as a broken filter. */}
				{events.length > 0 || filters.eventName ? (
					<SearchableFilterSection
						title={FILTER_SECTION_LABEL_TEXT.eventName}
						options={events.map((event) => ({ name: event.name, count: event.sessions }))}
						{...single("eventName")}
					/>
				) : null}
				<Separator className="my-1" />
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.referrerHost}
					options={toOptions(breakdowns.referrerHosts)}
					getOptionLabel={referrerLabel}
					renderOptionIcon={referrerIcon}
					{...single("referrerHost")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.utmSource}
					options={toOptions(breakdowns.utmSources)}
					getOptionLabel={utmLabel}
					renderOptionIcon={utmSourceIcon}
					{...single("utmSource")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL_TEXT.utmMedium}
					options={toOptions(breakdowns.utmMediums)}
					getOptionLabel={utmLabel}
					{...single("utmMedium")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.utmCampaign}
					options={toOptions(breakdowns.utmCampaigns)}
					getOptionLabel={utmLabel}
					{...single("utmCampaign")}
				/>
				<Separator className="my-1" />
				{/* Two exclusive checkboxes rather than a FilterSection: that component
				    requires a `count` per option and always renders it, and this filter has
				    no per-option count to give — the sidebar's other counts come from
				    server-side facet branches, and a hard-coded 0 beside "New" reads as
				    "zero new visitors" rather than as "not counted". Unchecking both means
				    all visitors. */}
				<div className="py-1">
					<h4 className={cn(FILTER_SECTION_LABEL, "py-1 text-muted-foreground")}>
						{FILTER_SECTION_LABEL_TEXT.visitorType}
					</h4>
					<SingleCheckboxFilter
						title="New"
						checked={filters.visitorType === "new"}
						onChange={(on) => onFilterChange("visitorType", on ? "new" : undefined)}
					/>
					<SingleCheckboxFilter
						title="Returning"
						checked={filters.visitorType === "returning"}
						onChange={(on) => onFilterChange("visitorType", on ? "returning" : undefined)}
					/>
				</div>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.country}
					options={toOptions(breakdowns.countries)}
					getOptionLabel={countryLabel}
					{...single("country")}
				/>
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL_TEXT.language}
					options={toOptions(breakdowns.languages)}
					getOptionLabel={languageLabel}
					{...single("language")}
				/>
				<Separator className="my-1" />
				<FilterSection
					title={FILTER_SECTION_LABEL_TEXT.deviceType}
					options={toOptions(breakdowns.deviceTypes)}
					getOptionIcon={deviceIconFor}
					{...single("deviceType")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL_TEXT.browserName}
					options={toOptions(breakdowns.browsers)}
					getOptionIcon={browserIconFor}
					{...single("browserName")}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL_TEXT.osName}
					options={toOptions(breakdowns.operatingSystems)}
					{...single("osName")}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
