import { getCollection, type CollectionEntry } from "astro:content"

export type Release = CollectionEntry<"changelog">

/** Releases newest first. Drafts are excluded in production builds. */
export async function getSortedReleases(): Promise<Release[]> {
	const releases = await getCollection("changelog", ({ data }) => !data.draft || import.meta.env.DEV)
	return releases.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
}

/** "07" — zero-padded month for the ledger's tabular-numeral column. */
export function monthLabel(date: Date): string {
	return String(date.getUTCMonth() + 1).padStart(2, "0")
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" })

/** "July 2026" — the release's own name, derived rather than re-typed. */
export function monthName(date: Date): string {
	return MONTH_FMT.format(date)
}
