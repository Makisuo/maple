import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import { extractHeadings, stripMarkdown, type SearchDoc } from "../../lib/docs-search"

/**
 * Prebuilt search index for the docs ⌘K palette. Emitted as a static
 * `/docs/search-index.json` at build (and served live under `astro dev`); the
 * client fetches it once on first idle/open and feeds it to Fuse.js.
 */
export const GET: APIRoute = async () => {
	const docs = await getCollection("docs", ({ data }) => !data.draft)

	const records: SearchDoc[] = docs.map((doc) => {
		const body = doc.body ?? ""
		return {
			id: doc.id,
			url: `/docs/${doc.id}`,
			title: doc.data.title,
			description: doc.data.description,
			group: doc.data.group,
			headings: extractHeadings(body).join(" · "),
			content: stripMarkdown(body),
		}
	})

	return new Response(JSON.stringify(records), {
		headers: { "Content-Type": "application/json" },
	})
}
