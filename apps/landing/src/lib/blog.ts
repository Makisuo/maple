import { getCollection, type CollectionEntry } from "astro:content"

export type BlogPost = CollectionEntry<"blog">

export type BlogCategory = NonNullable<BlogPost["data"]["category"]>

/** Human label + the token used to tint the generated cover motif, per category. */
export const CATEGORY_META: Record<BlogCategory, { label: string }> = {
	engineering: { label: "engineering" },
	product: { label: "product" },
	guides: { label: "guides" },
	company: { label: "company" },
} satisfies Record<BlogCategory, { label: string }>

/** Published posts, newest first. Drafts are excluded in production builds. */
export async function getSortedPosts(): Promise<BlogPost[]> {
	const posts = await getCollection("blog", ({ data }) => !data.draft || import.meta.env.DEV)
	return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
}

/** Estimated read time in whole minutes (~200 wpm), floored at 1. */
export function readingTime(body: string | undefined): number {
	const words = (body ?? "").trim().split(/\s+/).filter(Boolean).length
	return Math.max(1, Math.round(words / 200))
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" })

/** "jun 20, 2026" — lowercase to match the docs-index terminal idiom. */
export function formatDate(date: Date): string {
	return DATE_FMT.format(date).toLowerCase()
}

/** ISO date for <time datetime> and JSON-LD. */
export function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10)
}
