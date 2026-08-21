/**
 * `/index.md` — the agent-readable twin of the home page, and the target of
 * `Accept: text/markdown` on `/` (see `src/worker.ts`).
 *
 * Same facts the homepage states for AI extraction (the FAQ, the three steps,
 * the feature sheet), reduced to headings, lists, and links. No marketing
 * plates: a model citing this page wants the entity facts and the URLs.
 */
import type { APIRoute } from "astro"
import { features } from "../lib/features"
import { useCases } from "../lib/use-cases"
import { API_PATHS, GITHUB_URL, SITE_PATHS, apiUrl } from "../lib/agent-resources"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"
import { featurePath, useCasePath } from "../lib/page-registry"
import * as m from "../paraglide/messages.js"

export const GET: APIRoute = ({ site }) => {
	const url = (path: string) => absolute(site, path)

	return markdown(
		blocks(
			docHeader("Maple — Open-source observability for traces, logs, and metrics", m.page_home_desc()),
			`${m.hero_title()} ${m.hero_title_sub()} ${m.hero_title_accent()} ${m.hero_subtitle()}`,

			"## What Maple is",
			[
				`- **${m.faq_home_what_q()}** ${m.faq_home_what_a()}`,
				`- **${m.faq_home_oss_q()}** ${m.faq_home_oss_a()}`,
				`- **${m.faq_home_otel_q()}** ${m.faq_home_otel_a()}`,
				`- **${m.faq_home_price_q()}** ${m.faq_home_price_a()}`,
				`- **${m.faq_home_agents_q()}** ${m.faq_home_agents_a()}`,
				`- **${m.faq_selfhost_q()}** ${m.faq_selfhost_a()}`,
			].join("\n"),

			`## ${m.how_heading()}`,
			[
				`1. **${m.how_step1_title()}** — ${m.how_step1_desc()}`,
				`2. **${m.how_step2_title()}** — ${m.how_step2_desc()}`,
				`3. **${m.how_step3_title()}** — ${m.how_step3_desc()}`,
			].join("\n"),

			"## Features",
			features
				.map(
					(feature) =>
						`- [${feature.navLabel()}](${url(`${featurePath("en", feature.slug)}.md`)}) — ${feature.navDesc()}`,
				)
				.join("\n"),

			"## Use cases",
			useCases
				.map(
					(useCase) =>
						`- [${useCase.navLabel()}](${url(`${useCasePath("en", useCase.slug)}.md`)}) — ${useCase.navDesc()}`,
				)
				.join("\n"),

			"## For developers and agents",
			[
				`- [Documentation](${url("/docs.md")}) · [single-file docs](${url(SITE_PATHS.llmsFull)})`,
				`- [Pricing](${url("/pricing.md")})`,
				`- [Maple API](${url(`${SITE_PATHS.apiDocs}.md`)}) — base URL \`${apiUrl(API_PATHS.reference).replace(API_PATHS.reference, "")}\`, [interactive reference](${apiUrl(API_PATHS.reference)}), [OpenAPI 3.1](${url(SITE_PATHS.openapi)})`,
				`- [MCP server](${url(`${SITE_PATHS.mcpDocs}.md`)}) — \`${apiUrl(API_PATHS.mcp)}\` (Streamable HTTP), [manifest](${url(SITE_PATHS.mcpManifest)})`,
				`- [Command line tool](${url("/docs/local-mode/cli-reference.md")}) — \`curl -fsSL ${url("/cli/install")} | sh\` or \`brew install Makisuo/tap/maple\``,
				`- [Source code](${GITHUB_URL})`,
				`- [Site index for agents](${url(SITE_PATHS.llmsTxt)})`,
			].join("\n"),

			"## Company",
			[
				`- [About Maple](${url(`${SITE_PATHS.about}.md`)})`,
				`- [Contact](${url(`${SITE_PATHS.contact}.md`)})`,
				`- [Privacy](${url("/privacy")}) · [Terms](${url("/terms")})`,
			].join("\n"),
		),
	)
}
