/**
 * `/changelog/<slug>.md` — one release note, verbatim.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { getSortedReleases, monthName } from "../../lib/changelog"
import { blocks, docHeader, markdown } from "../../lib/page-markdown"
import type { Release } from "../../lib/changelog"

export const getStaticPaths: GetStaticPaths = async () => {
	const releases = await getSortedReleases()
	return releases.map((release) => ({ params: { slug: release.id }, props: { release } }))
}

export const GET: APIRoute = ({ props }) => {
	const { release } = props as { release: Release }

	const highlights = release.data.highlights.length
		? ["## Highlights", "", ...release.data.highlights.map((h) => `- ${h}`)].join("\n")
		: undefined

	return markdown(
		blocks(
			docHeader(release.data.title, release.data.description),
			`Released ${monthName(release.data.date)}.${release.data.breaking ? " **Contains breaking changes.**" : ""}`,
			highlights,
			release.body ?? "",
		),
	)
}
