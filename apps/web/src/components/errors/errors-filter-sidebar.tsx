import { useMemo } from "react"
import { getRouteApi } from "@tanstack/react-router"

import type { IssueKind } from "@maple/domain/http"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { FilterSection, SingleCheckboxFilter, serviceColorMap } from "@/components/traces/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@/components/filters/filter-sidebar"
import { getErrorsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { ERRORS_WINDOW } from "@/components/errors/errors-hub"
import { CLEARED_ERROR_FILTERS, KIND_LABEL, hasErrorFilters } from "@/lib/errors/error-filter-chips"
import { SOURCES, SOURCE_COLOR, SOURCE_DESCRIPTION, SourceLegend } from "./issue-source"

/**
 * Filters over what the issue list is actually made of.
 *
 * The previous sidebar was the events view's: four warehouse facets over a time
 * window plus two toggles about which spans to count. None of that is what the
 * rows are. Issues are one per fingerprint, in Postgres, in every state, from
 * every span — so a facet that ranked the window's top fingerprints dropped
 * anything older than a day, and the root-only and scanner-noise toggles never
 * changed a row at all. Every control here maps to a filter the issues API
 * applies itself, which is what keeps paging honest under a filter.
 *
 * Single-select for now: the API takes one service and one environment. The
 * counts beside services are open issues per service, from the one issue-side
 * count the API has; environment and kind carry no count rather than a number
 * about something else.
 */

const routeApi = getRouteApi("/errors/")

const KINDS: ReadonlyArray<IssueKind> = SOURCES
const KIND_OPTIONS = KINDS.map((name) => ({ name, count: 0 }))
const isIssueKind = (value: string): value is IssueKind => KINDS.includes(value as IssueKind)

/** Checkbox lists, single-select: the newest tick replaces the current one. */
const pickOne = (current: string | undefined, next: ReadonlyArray<string>): string | undefined =>
	next.find((value) => value !== current) ?? (next.includes(current ?? "") ? current : undefined)

export function ErrorsFilterSidebar() {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()

	const serviceCounts = useAtomValue(
		retainedQueryV2("errorIssues", "serviceCounts", { reactivityKeys: ["errorIssues"] }),
	)
	const services = useMemo(
		() =>
			Result.isSuccess(serviceCounts)
				? serviceCounts.value.data.map((row) => ({ name: row.service_name, count: row.open_count }))
				: [],
		[serviceCounts],
	)

	// The environment vocabulary comes from the warehouse, since an issue does
	// not carry one; the API resolves the filter itself over a month of
	// fingerprints. The trend window is enough to list the names.
	const trendWindow = useEffectiveTimeRange(undefined, undefined, ERRORS_WINDOW)
	const facets = useRefreshableAtomValue(
		getErrorsFacetsResultAtom({
			data: { startTime: trendWindow.startTime, endTime: trendWindow.endTime },
		}),
	)
	const environments = useMemo(
		() =>
			Result.isSuccess(facets)
				? (facets.value.data.deploymentEnvs ?? []).map((env) => ({ name: env.name, count: 0 }))
				: [],
		[facets],
	)

	const setFilter = <K extends keyof typeof search>(key: K, value: (typeof search)[K]) => {
		navigate({ search: (prev) => ({ ...prev, [key]: value }) })
	}

	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader
				canClear={hasErrorFilters(search)}
				onClear={() => navigate({ search: (prev) => ({ ...prev, ...CLEARED_ERROR_FILTERS }) })}
			/>
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Regressed only"
					checked={search.regressed ?? false}
					onChange={(checked) => setFilter("regressed", checked || undefined)}
				/>

				<FilterSection
					title="Service"
					options={services}
					selected={search.service ? [search.service] : []}
					onChange={(values) => setFilter("service", pickOne(search.service, values))}
					colorMap={serviceColorMap(services)}
				/>

				<FilterSection
					title="Environment"
					options={environments}
					selected={search.env ? [search.env] : []}
					onChange={(values) => setFilter("env", pickOne(search.env, values))}
					showCounts={false}
				/>

				<FilterSection
					title="Source"
					description={<SourceLegend />}
					colorMap={SOURCE_COLOR}
					getOptionDescription={(name) =>
						isIssueKind(name) ? SOURCE_DESCRIPTION[name] : undefined
					}
					options={KIND_OPTIONS}
					selected={search.kind ? [search.kind] : []}
					onChange={(values) => {
						const next = pickOne(search.kind, values)
						setFilter("kind", next !== undefined && isIssueKind(next) ? next : undefined)
					}}
					getOptionLabel={(name) => (isIssueKind(name) ? KIND_LABEL[name] : name)}
					showCounts={false}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
