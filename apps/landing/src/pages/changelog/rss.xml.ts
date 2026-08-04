import rss from "@astrojs/rss"
import type { APIContext } from "astro"
import { getSortedReleases } from "../../lib/changelog"

export async function GET(context: APIContext) {
	const releases = await getSortedReleases()

	// `context.site` is astro.config.mjs `site` — required for absolute links.
	const site = context.site ?? new URL("https://maple.dev")

	return rss({
		title: "Maple changelog",
		description: "Every Maple release, month by month.",
		site,
		items: releases.map((release) => {
			// The cover leads the item body rather than riding as an <enclosure>:
			// enclosures require a byte length we'd have to keep in sync with the
			// file by hand, and readers render an inline <img> just as well.
			const cover = release.data.cover
				? `<p><img src="${escapeHtml(new URL(release.data.cover, site).toString())}" alt="${escapeHtml(release.data.coverAlt ?? "")}" /></p>`
				: ""
			// Highlights as the item body: enough to decide whether to click
			// through, without shipping the full release note in the feed.
			const highlights = release.data.highlights.length
				? `<ul>${release.data.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
				: ""

			return {
				title: release.data.title,
				pubDate: release.data.date,
				description: release.data.description,
				link: `/changelog/${release.id}`,
				content: cover + highlights || undefined,
			}
		}),
		customData: "<language>en-us</language>",
	})
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
