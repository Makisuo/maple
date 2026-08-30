// Shared filter vocabulary for the Web Analytics page.
//
// Every filter is single-valued, matching the query builder's filter surface
// (packages/query-engine/src/ch/queries/web-analytics.ts). Single rather than
// multi-select is a deliberate narrowing: the panels answer "how does this slice
// behave", and the honest way to compare two countries is two looks, not a
// union that neither the KPI row nor the coverage figure could attribute.

import { Schema } from "effect"
import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"

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
	traffic: Schema.optional(Schema.Literals(["all", "humans", "bots"])),
	eventName: Schema.optional(Schema.String),
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
	/**
	 * Which agents count. Never absent once decoded — {@link filtersFromSearch}
	 * substitutes {@link DEFAULT_TRAFFIC} — so every query on the page states its
	 * population rather than inheriting one.
	 */
	traffic?: "all" | "humans" | "bots"
	/** Sessions in which a `track(eventName)` call fired. */
	eventName?: string
}

export type AnalyticsFilterKey = keyof AnalyticsFilters

/**
 * Crawlers are excluded unless you ask for them.
 *
 * "Visitors" means people, and for most of this page's life it did not: a site
 * being crawled hard reported Googlebot as ten thousand unique mobile Chrome
 * users, and every headline, breakdown and funnel on the page inherited that.
 * A default of `all` keeps the old numbers and asks each customer to discover
 * the problem themselves, which is the wrong way round — the correct number
 * should not be the one you have to opt into.
 *
 * The cost is that figures move, sharply, on exactly the orgs where they were
 * most wrong. That is why the bot-share line above the strip reports the split
 * for the window regardless of this setting, and why `all` stays one click away
 * in the sidebar's Traffic section.
 */
export const DEFAULT_TRAFFIC = "humans" as const

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
	traffic: "traffic",
	eventName: "event",
} satisfies Record<AnalyticsFilterKey, string>

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
	traffic: "Traffic",
	eventName: "Event",
} satisfies Record<AnalyticsFilterKey, string>

const FILTER_KEYS = Object.keys(FILTER_CHIP_LABEL) as ReadonlyArray<AnalyticsFilterKey>

/** Pull just the filter fields out of the route's search object. */
export const filtersFromSearch = (search: Record<string, unknown>): AnalyticsFilters => {
	const out: AnalyticsFilters = {}
	for (const key of FILTER_KEYS) {
		const value = search[key]
		if (typeof value !== "string" || value === "") continue
		if (key === "visitorType") {
			if (value === "new" || value === "returning") out.visitorType = value
		} else if (key === "traffic") {
			// `all` is a value here, not an absence: with a non-`all` default, the
			// URL has to be able to say "no, actually show me everything".
			if (value === "all" || value === "humans" || value === "bots") out.traffic = value
		} else {
			out[key] = value
		}
	}
	// Applied after the loop, so an explicit `?traffic=` in the URL always wins
	// over the default and a page loaded from a shared link shows what the sender
	// was looking at.
	out.traffic ??= DEFAULT_TRAFFIC
	return out
}

export interface ActiveFilterChip {
	readonly key: AnalyticsFilterKey
	readonly value: string
	/** What the chip reads, e.g. `country:DE`. */
	readonly label: string
}

/**
 * The empty-group sentinel as a chip reads — lower case like the rest of the
 * chip, and the same words the breakdown row used (`referrerLabel`/`utmLabel`).
 */
const chipValue = (key: AnalyticsFilterKey, value: string): string => {
	if (value !== WEB_ANALYTICS_UNSET) return value
	return key === "referrerHost" ? "direct" : "not set"
}

/**
 * Flatten the filter object into one removable chip per set filter.
 *
 * `traffic` at its default is not a chip. Every chip here is something you did,
 * and a permanent `traffic:humans` on an otherwise unfiltered page would read as
 * a filter you forgot to clear — while also making "Clear all" look available on
 * a page with nothing to clear. Choosing `all` or `bots` is a choice, and does
 * get a chip.
 */
export const activeFilterChips = (filters: AnalyticsFilters): ReadonlyArray<ActiveFilterChip> =>
	FILTER_KEYS.flatMap((key) => {
		const value = filters[key]
		if (!value || (key === "traffic" && value === DEFAULT_TRAFFIC)) return []
		return [{ key, value, label: `${FILTER_CHIP_LABEL[key]}:${chipValue(key, value)}` }]
	})

/**
 * The Traffic section is two checkboxes over a three-valued filter, and they
 * behave the way two checkboxes look like they should: ticking both means both.
 *
 * `all` is therefore not a third option competing with the other two — it is
 * what "Humans and Bots" is called once it reaches the query layer. Unticking
 * the last remaining box widens to `all` rather than selecting nothing, since a
 * page filtered to neither population has nothing to show and no way back.
 */
export const toggleTraffic = (
	current: AnalyticsFilters["traffic"],
	which: "humans" | "bots",
	on: boolean,
): "all" | "humans" | "bots" => {
	const humans = which === "humans" ? on : trafficIncludes(current, "humans")
	const bots = which === "bots" ? on : trafficIncludes(current, "bots")
	if (humans && bots) return "all"
	if (humans) return "humans"
	if (bots) return "bots"
	return "all"
}

/** Whether the current setting counts this population — drives the checkboxes. */
export const trafficIncludes = (traffic: AnalyticsFilters["traffic"], which: "humans" | "bots"): boolean => {
	const effective = traffic ?? DEFAULT_TRAFFIC
	return effective === "all" || effective === which
}

/** Whether anything is narrowed beyond the page's defaults — drives "Clear all". */
export const hasActiveFilters = (filters: AnalyticsFilters): boolean => activeFilterChips(filters).length > 0

/**
 * Clicking the already-selected value clears it. A breakdown row is the only
 * affordance for un-setting a filter you set from the same table, so making the
 * click a toggle is what keeps the table navigable in both directions.
 */
export const toggleFilterValue = (current: string | undefined, value: string): string | undefined =>
	current === value ? undefined : value
