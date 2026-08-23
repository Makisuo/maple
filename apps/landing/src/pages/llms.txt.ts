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
import { API_ORIGIN, API_PATHS, GITHUB_URL, SITE_PATHS } from "../lib/agent-resources"

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

		"## Guides",
		"",
		"Evergreen explanations of application performance monitoring, observability, OpenTelemetry, and the tools used to operate production software.",
		"",
		`- [Guides index](${url("/guides")})`,
		`- [What is APM, and why is it important?](${url("/guides/what-is-apm")})`,
		`- [What is observability?](${url("/observability")})`,
		`- [What is OpenTelemetry?](${url("/opentelemetry")})`,
		`- [Best open-source observability tools](${url("/best-open-source-observability-tools")})`,
		"",

		"## Maple API",
		"",
		`REST API for the Maple observability platform, base URL \`${API_ORIGIN}/v2\`. Bearer auth with a Maple API key (\`maple_ak_…\`); JSON in and out; every error is a \`{ "error": { "_tag", "type", "code", "message" } }\` envelope; 600 requests/minute per key with \`Retry-After\` on 429.`,
		"",
		`- [Maple API guide](${url(`${SITE_PATHS.apiDocs}.md`)}) — authentication, conventions, errors, rate limits`,
		`- [OpenAPI 3.1 specification (JSON)](${url(SITE_PATHS.openapi)}) — every operation has an operationId, description, typed parameters and response schemas`,
		`- [Interactive API reference](${API_ORIGIN}${API_PATHS.reference})`,
		`- [Same spec served by the API](${API_ORIGIN}${API_PATHS.openapi})`,
		"",

		"## MCP server",
		"",
		`Maple exposes its API to AI agents as a hosted Model Context Protocol server over Streamable HTTP at \`${API_ORIGIN}${API_PATHS.mcp}\`. Authenticate with a Maple API key as a Bearer token, or let the client complete the OAuth flow advertised at \`${API_ORIGIN}${API_PATHS.oauthResource}\`.`,
		"",
		`- [MCP server guide](${url(`${SITE_PATHS.mcpDocs}.md`)}) — connecting Claude, Cursor, and other clients; available tools`,
		`- [MCP server manifest (server.json)](${url(SITE_PATHS.mcpManifest)}) — also at ${url(SITE_PATHS.mcpServerJson)} and ${API_ORIGIN}${API_PATHS.mcpManifest}`,
		`- [AI & MCP feature page](${url("/features/ai-mcp-integration.md")})`,
		"",

		"## Command line tool",
		"",
		"The official `maple` CLI runs the whole platform locally against a single embedded ClickHouse binary — no account required — and talks to the hosted service for the rest.",
		"",
		`- Homebrew: \`brew install Makisuo/tap/maple\``,
		`- Install script: \`curl -fsSL ${url("/cli/install")} | sh\` ([source](${url("/cli/install")}))`,
		`- [Releases on GitHub](${GITHUB_URL}/releases)`,
		`- [CLI reference](${url("/docs/local-mode/cli-reference.md")})`,
		"",

		"## SDKs and instrumentation",
		"",
		"Maple ingests OpenTelemetry, so any OTel SDK works unmodified. The Effect SDK and the per-language guides are documented here.",
		"",
		`- [SDK overview](${url("/docs/sdks/overview.md")})`,
		`- [Effect SDK](${url("/docs/sdks/effect.md")})`,
		`- [Repository](${GITHUB_URL})`,
		"",

		"## Brand",
		"",
		"Logo, wordmark, colours, and type, with a downloadable kit. Use the artwork as it is rather than redrawing it.",
		"",
		...both("Brand assets", "/brand"),
		`- [Brand kit archive](${url("/brand/maple-brand-kit.zip")})`,
		"",

		"## Company",
		"",
		"Maple is built and operated by Makisuo, Inc.",
		"",
		...both("About Maple", SITE_PATHS.about),
		...both("Contact", SITE_PATHS.contact),
		`- [Privacy policy](${url("/privacy")})`,
		`- [Terms of service](${url("/terms")})`,
		"",

		"## Community",
		"",
		"- [Discord](https://discord.gg/BnXjKuwJqP)",
		"- [X](https://x.com/Mapledotdev)",
	].join("\n")

	return plainText(body)
}
