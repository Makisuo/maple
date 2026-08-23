import { formatWarehouseDateTime } from "@maple/query-engine"
import type { FunnelPopulationFilterField } from "@maple/query-model"

import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import {
	productEventNamesResultAtom,
	webAnalyticsBreakdownsResultAtom,
	webAnalyticsPagesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { FunnelStepSuggestion } from "./funnel-step-builder"

// What the funnel panel's inputs complete from, over one time window: the
// `track()` event names for event steps, page paths for page steps, and the
// session facets (referrer, country, UTM, …) for the population filter. One
// hook so the dashboard panel fetches exactly what the /analytics view does,
// sized the same way.

const EVENT_NAME_LIMIT = 200
const PAGE_SUGGESTION_LIMIT = 100
const FACET_LIMIT = 50

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

export interface FunnelSuggestions {
	readonly eventNames: ReadonlyArray<FunnelStepSuggestion>
	readonly pagePaths: ReadonlyArray<FunnelStepSuggestion>
	/** Per population-filter field, the values seen in the window. */
	readonly facets: Partial<Record<FunnelPopulationFilterField, string[]>>
}

/**
 * Suggestions over `window`, or the last seven days when the caller has no
 * resolved range yet. A fresh org's panel shows none and the inputs stay
 * free-text — a funnel is often built for an event that has not fired yet.
 */
export function useFunnelSuggestions(window: { startTime: string; endTime: string } | undefined): FunnelSuggestions {
	const startTime = window?.startTime ?? formatWarehouseDateTime(Date.now() - SEVEN_DAYS_MS)
	const endTime = window?.endTime ?? formatWarehouseDateTime(Date.now())

	const eventNamesResult = useRetainedRefreshableResultValue(
		productEventNamesResultAtom({ data: { startTime, endTime, limit: EVENT_NAME_LIMIT } }),
	)
	const pagesResult = useRetainedRefreshableResultValue(
		webAnalyticsPagesResultAtom({ data: { startTime, endTime, limit: PAGE_SUGGESTION_LIMIT } }),
	)
	const facetsResult = useRetainedRefreshableResultValue(
		webAnalyticsBreakdownsResultAtom({ data: { startTime, endTime, limitPerDimension: FACET_LIMIT } }),
	)

	const eventNames = Result.builder(eventNamesResult)
		.onSuccess((rows) =>
			// The picker lists `track()` events; page views are the Page step's business.
			rows.data
				.filter((row) => row.kind !== "navigation")
				.map((row) => ({ name: row.eventName, count: row.count })),
		)
		.orElse(() => [])
	const pagePaths = Result.builder(pagesResult)
		.onSuccess((rows) => rows.data.map((page) => ({ name: page.pagePath, count: page.pageViews })))
		.orElse(() => [])
	const facets = Result.builder(facetsResult)
		.onSuccess((rows): FunnelSuggestions["facets"] => {
			const names = (facet: ReadonlyArray<{ name: string }>) => facet.map((row) => row.name).filter(Boolean)
			return {
				referrerHost: names(rows.referrerHosts),
				country: names(rows.countries),
				deviceType: names(rows.deviceTypes),
				browserName: names(rows.browsers),
				osName: names(rows.operatingSystems),
				language: names(rows.languages),
				utmSource: names(rows.utmSources),
				utmMedium: names(rows.utmMediums),
				utmCampaign: names(rows.utmCampaigns),
				pagePath: names(rows.entryPaths),
			}
		})
		.orElse((): FunnelSuggestions["facets"] => ({}))

	return { eventNames, pagePaths, facets }
}
