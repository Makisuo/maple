/**
 * Copy for the trust pages — `/about` and `/contact` — in one place so the HTML
 * page and its `.md` twin render the same words. Literal English, like
 * `PrivacyContent.astro` and `TermsContent.astro`: these pages are un-prefixed
 * and English-only.
 *
 * Facts only. Anything here is quoted by answer engines verifying that Maple
 * is a real company, so nothing aspirational and no numbers that go stale.
 */
import {
	API_ORIGIN,
	API_PATHS,
	DISCORD_URL,
	GITHUB_URL,
	LEGAL_EMAIL,
	PRIVACY_EMAIL,
	SITE_PATHS,
	SUPPORT_EMAIL,
	X_URL,
} from "./agent-resources"

export interface CompanySection {
	heading: string
	/** Paragraphs in markdown; links are written as `[text](url)`. */
	paragraphs: string[]
	/** Optional bullet list rendered after the paragraphs. */
	bullets?: string[]
}

export interface CompanyPage {
	title: string
	description: string
	sections: CompanySection[]
}

export const LEGAL_ENTITY = "Makisuo, Inc."

export const aboutPage: CompanyPage = {
	title: "About Maple",
	description:
		"Maple is an open-source observability platform for traces, logs, and metrics, built on OpenTelemetry and backed by ClickHouse, operated by Makisuo, Inc.",
	sections: [
		{
			heading: "What Maple is",
			paragraphs: [
				"Maple is an observability platform for distributed systems. It ingests traces, logs, and metrics over the OpenTelemetry protocol (OTLP), stores them in ClickHouse, and gives engineers a single place to search, correlate, and alert on them — distributed tracing with a service map, log search, metrics dashboards, error tracking with issue grouping, session replay for browser and mobile apps, Kubernetes monitoring, and alerting to Slack, email, and webhooks.",
				"There are no proprietary agents. Any application already instrumented with an OpenTelemetry SDK, collector, or auto-instrumentation can point its OTLP exporter at Maple and start sending data; switching observability vendors means changing an endpoint and a key, not re-instrumenting.",
			],
		},
		{
			heading: "Built for AI agents as much as for people",
			paragraphs: [
				`Maple ships a hosted Model Context Protocol (MCP) server at \`${API_ORIGIN}${API_PATHS.mcp}\` and a documented, stability-committed REST API (\`${API_ORIGIN}/v2\`), so coding agents and automation can list services, search traces and logs, find and triage errors, build dashboards, and manage alert rules against production telemetry. The website itself serves a markdown twin of every page (append \`.md\`, or send \`Accept: text/markdown\`), indexed at [llms.txt](${SITE_PATHS.llmsTxt}).`,
			],
		},
		{
			heading: "Open source",
			paragraphs: [
				`The source code is public at [github.com/Makisuo/maple](${GITHUB_URL}) under the Functional Source License (FSL-1.1); each release converts to Apache 2.0 two years after publication. You can read every line, self-host the whole platform, or use the hosted service at maple.dev. Maple Local packages the same platform — ingest, query engine, and UI — as a single binary with an embedded ClickHouse for laptops and CI.`,
			],
		},
		{
			heading: "Company",
			paragraphs: [
				`Maple is built and operated by ${LEGAL_ENTITY}, which also publishes the Maple SDKs (\`@maple-dev/effect-sdk\`, \`@maple-dev/browser\`, and the Swift SDK) and the \`maple\` command-line tool. The hosted service runs on Cloudflare and ClickHouse-compatible storage; the ingest gateway is written in Rust, the API and web application in TypeScript with Effect.`,
				`Questions, press, and partnerships: [${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL}). See the [contact page](${SITE_PATHS.contact}) for every channel, and the [privacy policy](/privacy) and [terms of service](/terms) for how the service is operated.`,
			],
		},
	],
}

export const contactPage: CompanyPage = {
	title: "Contact Maple",
	description:
		"How to reach the Maple team: support and general enquiries by email, community on Discord and GitHub, and the dedicated addresses for privacy and legal matters.",
	sections: [
		{
			heading: "Support and general enquiries",
			paragraphs: [
				`Email [${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL}) for product support, billing, sales, press, and partnership questions. Include your organisation name and, for a technical issue, a trace or session link so we can look at the same data you are looking at.`,
			],
		},
		{
			heading: "Community",
			paragraphs: [
				"The fastest way to get an answer about instrumentation or to talk to other people running Maple is the community Discord. Bugs, feature requests, and pull requests go to the GitHub repository.",
			],
			bullets: [
				`[Discord](${DISCORD_URL}) — chat with the team and other users`,
				`[GitHub issues](${GITHUB_URL}/issues) — bugs and feature requests`,
				`[X / Twitter](${X_URL}) — release announcements`,
			],
		},
		{
			heading: "Privacy and legal",
			paragraphs: [
				`Data-protection requests (access, deletion, data processing agreements) go to [${PRIVACY_EMAIL}](mailto:${PRIVACY_EMAIL}); see the [privacy policy](/privacy). Legal notices and questions about the [terms of service](/terms) go to [${LEGAL_EMAIL}](mailto:${LEGAL_EMAIL}). Security reports are welcome at [${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL}) with "security" in the subject line.`,
			],
		},
		{
			heading: "Developer resources",
			paragraphs: [
				"If you are integrating with Maple programmatically, these are the entry points; none of them require contacting us first.",
			],
			bullets: [
				`[API reference](${API_ORIGIN}${API_PATHS.reference}) and [OpenAPI specification](${SITE_PATHS.openapi})`,
				`[MCP server](${SITE_PATHS.mcpDocs}) at \`${API_ORIGIN}${API_PATHS.mcp}\``,
				`[Documentation](/docs) · [Site index for agents](${SITE_PATHS.llmsTxt})`,
			],
		},
		{
			heading: "Company",
			paragraphs: [`Maple is operated by ${LEGAL_ENTITY}. [About Maple](${SITE_PATHS.about}).`],
		},
	],
}
