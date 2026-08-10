// Shared filter vocabulary for the Web Analytics page.
//
// Every filter is single-valued, matching the query builder's filter surface
// (packages/query-engine/src/ch/queries/web-analytics.ts). Single rather than
// multi-select is a deliberate narrowing: the panels answer "how does this slice
// behave", and the honest way to compare two countries is two looks, not a
// union that neither the KPI row nor the coverage figure could attribute.

import { Schema } from "effect"

/** URL search-param fields. Spread into the route's `validateSearch` schema. */
export const analyticsFilterSearchFields = {
	host: Schema.optional(Schema.String),
	pagePath: Schema.optional(Schema.String),
	referrerHost: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	browserName: Schema.optional(Schema.String),
	osName: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	utmSource: Schema.optional(Schema.String),
	utmMedium: Schema.optional(Schema.String),
	utmCampaign: Schema.optional(Schema.String),
	visitorType: Schema.optional(Schema.Literals(["new", "returning"])),
}

export interface AnalyticsFilters {
	host?: string
	pagePath?: string
	referrerHost?: string
	country?: string
	deviceType?: string
	browserName?: string
	osName?: string
	language?: string
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	visitorType?: "new" | "returning"
}

export type AnalyticsFilterKey = keyof AnalyticsFilters

/** Filter key → the singular noun used in chips. Short: these render in 10px mono. */
export const FILTER_CHIP_LABEL: Record<AnalyticsFilterKey, string> = {
	host: "host",
	pagePath: "page",
	referrerHost: "referrer",
	country: "country",
	deviceType: "device",
	browserName: "browser",
	osName: "os",
	language: "lang",
	utmSource: "utm_source",
	utmMedium: "utm_medium",
	utmCampaign: "utm_campaign",
	visitorType: "visitor",
}

/** Filter key → sidebar section heading. Sentence case, matching the rest of the app. */
export const FILTER_SECTION_LABEL: Record<AnalyticsFilterKey, string> = {
	host: "Site",
	pagePath: "Page",
	referrerHost: "Referrer",
	country: "Country",
	deviceType: "Device",
	browserName: "Browser",
	osName: "Operating system",
	language: "Language",
	utmSource: "UTM source",
	utmMedium: "UTM medium",
	utmCampaign: "UTM campaign",
	visitorType: "Visitor",
}

const FILTER_KEYS = Object.keys(FILTER_CHIP_LABEL) as ReadonlyArray<AnalyticsFilterKey>

/** Pull just the filter fields out of the route's search object. */
export const filtersFromSearch = (search: Record<string, unknown>): AnalyticsFilters => {
	const out: AnalyticsFilters = {}
	for (const key of FILTER_KEYS) {
		const value = search[key]
		if (typeof value !== "string" || value === "") continue
		if (key === "visitorType") {
			if (value === "new" || value === "returning") out.visitorType = value
		} else {
			out[key] = value
		}
	}
	return out
}

export interface ActiveFilterChip {
	readonly key: AnalyticsFilterKey
	readonly value: string
	/** What the chip reads, e.g. `country:DE`. */
	readonly label: string
}

/** Flatten the filter object into one removable chip per set filter. */
export const activeFilterChips = (filters: AnalyticsFilters): ReadonlyArray<ActiveFilterChip> =>
	FILTER_KEYS.flatMap((key) => {
		const value = filters[key]
		return value ? [{ key, value, label: `${FILTER_CHIP_LABEL[key]}:${value}` }] : []
	})

/**
 * Clicking the already-selected value clears it. A breakdown row is the only
 * affordance for un-setting a filter you set from the same table, so making the
 * click a toggle is what keeps the table navigable in both directions.
 */
export const toggleFilterValue = (current: string | undefined, value: string): string | undefined =>
	current === value ? undefined : value

/**
 * `ReferrerHost` and friends are `''` for sessions that never populated them,
 * and those rows are dropped server-side rather than shown as a blank label. A
 * dimension nobody sends therefore arrives as an empty list — which is the
 * signal the panels use to say "not collected" instead of "zero".
 */
export const DIRECT_REFERRER_NOTE =
	"Sessions with no referrer are excluded rather than bucketed as direct — an empty referrer also covers internal navigation and Referrer-Policy suppression."
