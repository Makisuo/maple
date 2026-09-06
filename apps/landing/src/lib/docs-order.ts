/**
 * Docs in reading order, grouped.
 *
 * `/docs.md`, `/llms-full.txt` and prev/next all need "every doc, in the
 * order the sidebar shows them". Kept out of `docs-nav.ts` on purpose: that
 * module is imported by client islands, and `astro:content` must not follow
 * it into a browser bundle.
 */
import { getCollection, type CollectionEntry } from "astro:content"
import { groupRank } from "./docs-nav"

export type Doc = CollectionEntry<"docs">

/** Every non-draft doc, grouped and ordered the way the sidebar orders them. */
export async function getDocGroups(): Promise<{ group: string; docs: Doc[] }[]> {
	const docs = await getCollection("docs", ({ data }) => !data.draft)

	const groups = new Map<string, Doc[]>()
	for (const doc of docs) {
		const bucket = groups.get(doc.data.group)
		if (bucket) bucket.push(doc)
		else groups.set(doc.data.group, [doc])
	}

	return [...groups.entries()]
		.sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
		.map(([group, items]) => ({
			group,
			docs: items.sort(
				(a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title),
			),
		}))
}
