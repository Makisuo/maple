/**
 * `/llms.txt` — the index that makes the `.md` twins discoverable.
 *
 * `public/robots.txt` already opts every AI crawler in by name; this tells them
 * where the machine-readable copy of the site lives. One section per content
 * family, each stating the `.md` convention in prose and giving one worked
 * example URL, so a model can generalize the pattern from a single fetch.
 *
 * Only URLs that actually resolve go in here. A dead link in the index is worse
 * than an absent section.
 */
import type { APIRoute } from "astro"
import { features } from "../lib/features"
import { useCases } from "../lib/use-cases"
import { absolute, plainText } from "../lib/page-markdown"

const CONVENTION = (family: string) =>
	`Append \`.md\` to any ${family} URL, or send \`Accept: text/markdown\`, to receive the raw markdown source.`

export const GET: APIRoute = ({ site }) => {
	const url = (path: string) => absolute(site, path)
	const both = (label: string, path: string) => [
		`- [${label} (Markdown)](${url(`${path}.md`)})`,
		`- [${label} (HTML)](${url(path)})`,
	]

	const body = [
		"# Maple",
		"",
		"> Maple is an open-source observability platform for traces, logs, and metrics, built on OpenTelemetry and backed by ClickHouse. Send OTLP from any instrumented app — no proprietary agents.",
		"",
		"For AI agents and automation, use the resources below.",
		"",

		"## Documentation",
		"",
		CONVENTION("docs"),
		"",
		...both("Docs index", "/docs"),
		`- [Full documentation, single file](${url("/llms-full.txt")})`,
		`- Example: [${url("/docs/getting-started/introduction.md")}](${url("/docs/getting-started/introduction.md")})`,
		"",

		"## Pricing",
		"",
		"Plans, included volume, and per-GB overage for logs, traces, metrics, and browser sessions.",
		"",
		...both("Pricing", "/pricing"),
		"",

		"## Changelog",
		"",
		`Maple product updates, month by month. The index enumerates every release. ${CONVENTION("changelog")}`,
		"",
		...both("Changelog index", "/changelog"),
		`- [RSS feed](${url("/changelog/rss.xml")})`,
		"",

		"## Roadmap",
		"",
		"What has shipped, what is being built, and what is being explored.",
		"",
		...both("Roadmap", "/roadmap"),
		"",

		"## Features",
		"",
		`One page per capability — tracing, session replay, logs, metrics, service catalog, error tracking, MCP, Kubernetes. ${CONVENTION("feature")}`,
		"",
		...features.map((feature) => `- [${feature.navLabel()}](${url(`/features/${feature.slug}.md`)})`),
		"",

		"## Use cases",
		"",
		`Worked debugging stories, step by step. ${CONVENTION("use-case")}`,
		"",
		...useCases.map((useCase) => `- [${useCase.navLabel()}](${url(`/use-cases/${useCase.slug}.md`)})`),
		"",

		"## Command line tool",
		"",
		"Run Maple locally against a single embedded ClickHouse binary — no account required.",
		"",
		`- [Install script](${url("/cli/install")})`,
		`- [CLI reference](${url("/docs/local-mode/cli-reference.md")})`,
		"",

		"## SDKs and instrumentation",
		"",
		"Maple ingests OpenTelemetry, so any OTel SDK works unmodified. The Effect SDK and the per-language guides are documented here.",
		"",
		`- [SDK overview](${url("/docs/sdks/overview.md")})`,
		`- [Effect SDK](${url("/docs/sdks/effect.md")})`,
		`- [Repository](https://github.com/Makisuo/maple)`,
		"",

		"## Legal",
		"",
		`- [Privacy policy](${url("/privacy")})`,
		`- [Terms of service](${url("/terms")})`,
		"",

		"## Community",
		"",
		"- [Discord](https://discord.gg/BnXjKuwJqP)",
		"- [X](https://x.com/maple_dev)",
	].join("\n")

	return plainText(body)
}
