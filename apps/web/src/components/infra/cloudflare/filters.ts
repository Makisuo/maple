// Shared filter vocabulary for the Cloudflare pages.
//
// The poller stores dimensions as single-dimension slices, not one cube, so a
// filter that applies to one panel may be inapplicable to the next. The API
// answers that per panel via `ignoredFilters`; this module holds the labels and
// the URL <-> request plumbing both pages share.

import { Schema } from "effect"
import { OptionalStringArrayParam } from "@/lib/search-params"

/** URL search-param fields. Spread into a route's `validateSearch` schema. */
export const cloudflareFilterSearchFields = {
	hosts: OptionalStringArrayParam,
	cacheStatuses: OptionalStringArrayParam,
	statusClasses: OptionalStringArrayParam,
	paths: OptionalStringArrayParam,
	pathContains: Schema.optional(Schema.String),
	countries: OptionalStringArrayParam,
	methods: OptionalStringArrayParam,
	protocols: OptionalStringArrayParam,
	deviceTypes: OptionalStringArrayParam,
}

export interface CloudflareFilters {
	hosts?: ReadonlyArray<string>
	cacheStatuses?: ReadonlyArray<string>
	statusClasses?: ReadonlyArray<string>
	paths?: ReadonlyArray<string>
	pathContains?: string
	countries?: ReadonlyArray<string>
	methods?: ReadonlyArray<string>
	protocols?: ReadonlyArray<string>
	deviceTypes?: ReadonlyArray<string>
}

export type CloudflareFilterKey = keyof CloudflareFilters

/**
 * Filter key → the singular noun used in chips and scope markers. Short on purpose: these render
 * inside 10px mono chips next to a panel title, so `path` beats `Request path`.
 */
export const FILTER_CHIP_LABEL: Record<CloudflareFilterKey, string> = {
	paths: "path",
	pathContains: "path~",
	hosts: "host",
	countries: "country",
	cacheStatuses: "cache",
	statusClasses: "status",
	methods: "method",
	protocols: "http",
	deviceTypes: "device",
} satisfies Record<CloudflareFilterKey, string>

/** Filter key → the sidebar section heading. Sentence case, matches the rest of the app. */
export const FILTER_SECTION_LABEL: Record<CloudflareFilterKey, string> = {
	paths: "Path",
	pathContains: "Path contains",
	hosts: "Host",
	countries: "Country",
	cacheStatuses: "Cache status",
	statusClasses: "Status class",
	methods: "Method",
	protocols: "Protocol",
	deviceTypes: "Device",
} satisfies Record<CloudflareFilterKey, string>

/**
 * The server reports ignored filters by its own key names (`path`, `host`, …); the UI holds the
 * plural search-param names. One mapping, so a scope marker can name the offending filter.
 */
const SERVER_KEY_TO_FILTER: Record<string, CloudflareFilterKey> = {
	path: "paths",
	host: "hosts",
	country: "countries",
	cacheStatus: "cacheStatuses",
	statusClass: "statusClasses",
	method: "methods",
	protocol: "protocols",
	deviceType: "deviceTypes",
} satisfies Record<string, CloudflareFilterKey>

export const filterKeysFromServer = (
	ignored: ReadonlyArray<string> | undefined,
): ReadonlyArray<CloudflareFilterKey> =>
	(ignored ?? [])
		.map((key) => SERVER_KEY_TO_FILTER[key])
		.filter((key): key is CloudflareFilterKey => key !== undefined)

const FILTER_KEYS = Object.keys(FILTER_CHIP_LABEL) as ReadonlyArray<CloudflareFilterKey>

/** Pull just the filter fields out of a route's search object. */
export const filtersFromSearch = (search: Record<string, unknown>): CloudflareFilters => {
	const out: CloudflareFilters = {}
	for (const key of FILTER_KEYS) {
		const value = search[key]
		if (key === "pathContains") {
			if (typeof value === "string" && value !== "") out.pathContains = value
		} else if (Array.isArray(value) && value.length > 0) {
			out[key] = value as ReadonlyArray<string>
		}
	}
	return out
}

export interface ActiveFilterChip {
	readonly key: CloudflareFilterKey
	readonly value: string
	/** What the chip reads, e.g. `path:/api/users`. */
	readonly label: string
}

/** Flatten the filter object into one removable chip per selected value. */
export const activeFilterChips = (filters: CloudflareFilters): ReadonlyArray<ActiveFilterChip> => {
	const chips: Array<ActiveFilterChip> = []
	for (const key of FILTER_KEYS) {
		if (key === "pathContains") {
			if (filters.pathContains)
				chips.push({
					key,
					value: filters.pathContains,
					label: `${FILTER_CHIP_LABEL[key]}${filters.pathContains}`,
				})
			continue
		}
		for (const value of filters[key] ?? []) {
			chips.push({ key, value, label: `${FILTER_CHIP_LABEL[key]}:${value}` })
		}
	}
	return chips
}

export const hasActiveFilters = (filters: CloudflareFilters): boolean => activeFilterChips(filters).length > 0

/** Toggle one value in a multi-select filter; returns undefined when the last value is removed. */
export const toggleFilterValue = (
	current: ReadonlyArray<string> | undefined,
	value: string,
): ReadonlyArray<string> | undefined => {
	const set = new Set(current ?? [])
	if (set.has(value)) set.delete(value)
	else set.add(value)
	return set.size === 0 ? undefined : [...set]
}
