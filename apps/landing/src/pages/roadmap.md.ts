/**
 * `/roadmap.md` — the roadmap grouped by status, shipped first.
 *
 * Entries carry their body as the detail, so this is the whole page rather than
 * a summary of it.
 */
import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import { blocks, docHeader, markdown } from "../lib/page-markdown"

const STATUS_ORDER = ["shipped", "in-progress", "planned", "exploring"] as const
const STATUS_HEADING: Record<(typeof STATUS_ORDER)[number], string> = {
	shipped: "Shipped",
	"in-progress": "In progress",
	planned: "Planned",
	exploring: "Exploring",
}

export const GET: APIRoute = async () => {
	const entries = await getCollection("roadmap")

	const sections = STATUS_ORDER.map((status) => {
		const items = entries
			.filter((entry) => entry.data.status === status)
			.sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title))

		if (items.length === 0) return undefined

		return blocks(
			`## ${STATUS_HEADING[status]}`,
			...items.map((entry) =>
				blocks(
					`### ${entry.data.title}`,
					`${entry.data.category} · ${entry.data.quarter}${entry.data.shipped_date ? ` · shipped ${entry.data.shipped_date}` : ""}`,
					entry.data.description,
					entry.body ?? "",
				),
			),
		)
	})

	return markdown(
		blocks(
			docHeader("Maple Roadmap", "What has shipped, what is being built, and what is being explored."),
			...sections,
		),
	)
}
