// Display labels for the coded dimensions.
//
// `Intl.DisplayNames` is the whole implementation: the browser already ships the
// CLDR region and language tables, so shipping our own map would be a few KB of
// data that goes stale. Both are constructed lazily and memoized, because
// constructing one per row is the expensive part, not the lookup.

import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"

/**
 * The empty-referrer group. "Direct" is what every analytics product calls it,
 * even though the bucket also covers internal navigation and Referrer-Policy
 * suppression — a longer, truer label would not fit a 12px row.
 */
export const referrerLabel = (host: string): string => (host === WEB_ANALYTICS_UNSET ? "Direct" : host)

/** The untagged group of a `utm_*` dimension. */
export const utmLabel = (value: string): string => (value === WEB_ANALYTICS_UNSET ? "Not set" : value)

const displayNames = (type: "region" | "language"): Intl.DisplayNames | undefined => {
	try {
		return new Intl.DisplayNames(undefined, { type, fallback: "none" })
	} catch {
		return undefined
	}
}

let regionNames: Intl.DisplayNames | undefined | null = null
let languageNames: Intl.DisplayNames | undefined | null = null

/** `DE` → `Germany 🇩🇪`, falling back to the raw code where CLDR has no entry. */
export const countryLabel = (code: string): string => {
	if (regionNames === null) regionNames = displayNames("region")
	// Only well-formed two-letter codes reach the flag path; the gateway already
	// rejects anything else (`derive_country` in apps/ingest/src/main.rs), but a
	// stray value must render as itself rather than as mojibake.
	if (!/^[A-Za-z]{2}$/.test(code)) return code
	const upper = code.toUpperCase()
	const name = regionNames?.of(upper)
	const flag = String.fromCodePoint(
		...[...upper].map((char) => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0))),
	)
	return name ? `${flag} ${name}` : `${flag} ${upper}`
}

/** `en-US` → `American English`, falling back to the raw tag. */
export const languageLabel = (tag: string): string => {
	if (languageNames === null) languageNames = displayNames("language")
	try {
		return languageNames?.of(tag) ?? tag
	} catch {
		// `of` throws on a structurally invalid tag; the SDK forwards
		// navigator.language verbatim, so one can arrive.
		return tag
	}
}
