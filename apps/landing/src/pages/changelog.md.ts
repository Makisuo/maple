/**
 * `/changelog.md` — every release as a flat list, newest first.
 */
import type { APIRoute } from "astro"
import { getSortedReleases, monthName } from "../lib/changelog"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"

export const GET: APIRoute = async ({ site }) => {
	const releases = await getSortedReleases()

	return markdown(
		blocks(
			docHeader(
				"Maple Changelog",
				"Every Maple release, month by month. Append `.md` to any changelog URL, or send `Accept: text/markdown`, to receive the raw markdown source.",
			),
			...releases.map((release) =>
				blocks(
					`## ${release.data.title}`,
					`${monthName(release.data.date)} · [${absolute(site, `/changelog/${release.id}.md`)}](${absolute(site, `/changelog/${release.id}.md`)})${release.data.breaking ? " · **breaking**" : ""}`,
					release.data.description,
					release.data.highlights.map((h) => `- ${h}`).join("\n"),
				),
			),
		),
	)
}
