import type { CompanyPage } from "./company"
import { blocks, docHeader, markdown } from "./page-markdown"

/** Absolutise root-relative links so the twin reads correctly when fetched on its own. */
const absolutise = (text: string, site: URL | undefined) =>
	text.replace(
		/\]\((\/[^)]*)\)/g,
		(_match, path: string) => `](${new URL(path, site ?? "https://maple.dev")})`,
	)

export const companyPageMarkdown = (page: CompanyPage, site: URL | undefined): Response =>
	markdown(
		blocks(
			docHeader(page.title, page.description),
			...page.sections.map((section) =>
				blocks(
					`## ${section.heading}`,
					...section.paragraphs.map((paragraph) => absolutise(paragraph, site)),
					section.bullets
						? section.bullets.map((bullet) => `- ${absolutise(bullet, site)}`).join("\n")
						: "",
				),
			),
		),
	)
