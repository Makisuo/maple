/**
 * `/docs.md` — the docs index as a flat, grouped link list.
 *
 * Every entry points at its own `.md` twin, so a crawler that lands here can
 * walk the whole tree without parsing a single page of HTML.
 */
import type { APIRoute } from "astro"
import { getDocGroups } from "../lib/docs-order"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"

export const GET: APIRoute = async ({ site }) => {
	const groups = await getDocGroups()

	return markdown(
		blocks(
			docHeader(
				"Maple Documentation",
				"Every Maple doc. Append `.md` to any docs URL, or send `Accept: text/markdown`, to receive the raw markdown source.",
			),
			`The full docs as a single file: [${absolute(site, "/llms-full.txt")}](${absolute(site, "/llms-full.txt")})`,
			...groups.map(({ group, docs }) =>
				[
					`## ${group}`,
					"",
					...docs.map(
						(doc) =>
							`- [${doc.data.title}](${absolute(site, `/docs/${doc.id}.md`)}) — ${doc.data.description}`,
					),
				].join("\n"),
			),
		),
	)
}
