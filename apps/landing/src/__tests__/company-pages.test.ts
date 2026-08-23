import { describe, expect, it } from "vitest"
import { aboutPage, contactPage } from "../lib/company"
import { companyPageMarkdown } from "../lib/company-markdown"
import { GET as aboutMd } from "../pages/about.md"
import { GET as contactMd } from "../pages/contact.md"

const context = { site: new URL("https://maple.dev") } as Parameters<typeof aboutMd>[0]

const plainLength = (page: typeof aboutPage) =>
	page.sections.flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])]).join(" ").length

describe("trust pages", () => {
	it("carry substantive content (well over the 500-character floor answer engines check)", () => {
		expect(plainLength(aboutPage)).toBeGreaterThan(1500)
		expect(plainLength(contactPage)).toBeGreaterThan(1000)
	})

	it("name the legal entity and a contact address", () => {
		const about = JSON.stringify(aboutPage)
		const contact = JSON.stringify(contactPage)
		expect(about).toContain("Makisuo, Inc.")
		expect(contact).toContain("mailto:support@maple.dev")
		expect(contact).toContain("mailto:privacy@getmaple.dev")
	})

	it("render .md twins with absolute links and the same headings", async () => {
		for (const [route, page] of [
			[aboutMd, aboutPage],
			[contactMd, contactPage],
		] as const) {
			const response = await route(context)
			expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
			const body = await response.text()
			expect(body.startsWith(`# ${page.title}\n`)).toBe(true)
			for (const section of page.sections) expect(body).toContain(`## ${section.heading}`)
			expect(body).not.toMatch(/\]\(\//)
			expect(body).toContain("](https://maple.dev/")
		}
	})

	it("keeps bullets as a markdown list", async () => {
		const body = await companyPageMarkdown(contactPage, new URL("https://maple.dev")).text()
		expect(body).toContain("- [Discord](https://discord.gg/")
	})
})
