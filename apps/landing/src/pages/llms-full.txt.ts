/**
 * `/llms-full.txt` — every doc concatenated into one file, in sidebar order.
 *
 * The single-fetch counterpart to walking `/docs.md` link by link. This is what
 * `/llms.txt` points at as "the full documentation".
 */
import type { APIRoute } from "astro"
import { getDocGroups } from "../lib/docs-order"
import { absolute, plainText } from "../lib/page-markdown"

export const GET: APIRoute = async ({ site }) => {
	const groups = await getDocGroups()

	const sections = groups.flatMap(({ group, docs }) =>
		docs.map((doc) =>
			[
				`# ${doc.data.title}`,
				"",
				`> ${group} · ${absolute(site, `/docs/${doc.id}`)}`,
				"",
				doc.data.description,
				"",
				(doc.body ?? "").trim(),
			].join("\n"),
		),
	)

	return plainText(
		[
			"# Maple Documentation",
			"",
			"> Every Maple doc, concatenated. Source: https://maple.dev/docs",
			"",
			sections.join("\n\n---\n\n"),
		].join("\n"),
	)
}
