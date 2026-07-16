// Data model for the "Best open-source observability tools" listicle.
// English-first GEO asset (ja/ko fall back to en per astro.config.mjs).
// Kept as structured data so the page render and the ItemList JSON-LD stay in sync,
// and so additional roundups ("Best Datadog alternatives", etc.) are cheap follow-ons.

export interface BestTool {
	/** 1-based rank shown in the roundup and emitted as ItemList position. */
	rank: number
	name: string
	/** kebab-case anchor id, also used for the in-page jump links. */
	slug: string
	/** Official project/product homepage. */
	url: string
	/** Short "Best for …" positioning tagline. */
	bestFor: string
	/** License / distribution model — conservative, honest descriptor. */
	license: string
	/** 2–3 sentence even-handed summary. */
	summary: string
	pros: string[]
	cons: string[]
	/** Internal link to an existing /compare/* page, when one exists. */
	comparePath?: string
}

export const lastUpdated = "June 2026"

export const methodology =
	"We build Maple, so it sits at #1 — factor that bias in; the rest of the list is played straight. " +
	"Every tool here is open source or source-available — you can read the code and self-host all of " +
	"them — and we note each one's license. We weighed how natively each one speaks OpenTelemetry, " +
	"whether it unifies traces, logs, and metrics in one place, and how much operational work a small " +
	"team takes on to run it. Rank is a starting point; the “Best for” tag matters more — pick the one " +
	"that matches how your team works."

export const bestObservabilityTools: BestTool[] = [
	{
		rank: 1,
		name: "Maple",
		slug: "maple",
		url: "https://maple.dev",
		bestFor: "OpenTelemetry-native teams who want AI-agent workflows and flat per-GB pricing",
		license: "Source-available (FSL-1.1 → Apache 2.0)",
		summary:
			"Maple is an OpenTelemetry-native observability platform built on ClickHouse, covering traces, logs, metrics, and browser session replay in one app. It ships a first-class MCP server so AI agents can search traces, find errors, and propose fixes, and it prices on usage instead of per-host or per-seat. Its source is available under FSL-1.1 (which converts to Apache 2.0), so you can read it, fork it, and self-host.",
		pros: [
			"OpenTelemetry-native — no proprietary agents or lock-in",
			"ClickHouse-grade query speed over billions of rows",
			"First-class MCP server for AI agents",
			"Session replay linked to your traces via a shared session id",
			"Transparent usage-based pricing; self-hostable",
		],
		cons: [
			"Younger project with a smaller ecosystem than the incumbents",
			"Fewer turnkey integrations than the Grafana stack today",
		],
	},
	{
		rank: 2,
		name: "Grafana (LGTM stack)",
		slug: "grafana",
		url: "https://grafana.com/oss/",
		bestFor: "Teams that want maximum flexibility and don't mind assembling components",
		license: "AGPLv3",
		summary:
			"The Grafana stack pairs Grafana dashboards with Loki (logs), Tempo (traces), and Mimir (metrics). It's the most widely deployed open-source option and endlessly flexible, but you assemble and operate several systems yourself.",
		pros: [
			"Huge ecosystem, plugins, and community",
			"Best-in-class dashboarding",
			"Mix and match Loki / Tempo / Mimir as needed",
		],
		cons: [
			"You run and tune multiple separate systems",
			"Operational overhead grows with scale",
			"OpenTelemetry support is good but bolted onto each component",
		],
		comparePath: "/compare/grafana",
	},
	{
		rank: 3,
		name: "SigNoz",
		slug: "signoz",
		url: "https://signoz.io/",
		bestFor: "Teams wanting an all-in-one OpenTelemetry-native APM",
		license: "MIT (with paid enterprise tier)",
		summary:
			"SigNoz is an OpenTelemetry-native, ClickHouse-backed APM that unifies traces, logs, and metrics in a single application — a close peer to Maple. It's a strong default if you want one open-source app instead of a stack to assemble.",
		pros: [
			"OpenTelemetry-native from the ground up",
			"Traces, logs, and metrics in one app",
			"ClickHouse storage for fast queries",
		],
		cons: ["Self-hosting still means operating ClickHouse", "Younger than the Grafana ecosystem"],
	},
	{
		rank: 4,
		name: "HyperDX",
		slug: "hyperdx",
		url: "https://www.hyperdx.io/",
		bestFor: "Full-stack debugging with session replay alongside logs and traces",
		license: "MIT",
		summary:
			"HyperDX is an open-source, OpenTelemetry + ClickHouse platform that correlates session replay with logs, traces, and metrics, so you can jump from a user's broken session to the span behind it. Good fit for product and full-stack teams.",
		pros: [
			"Session replay correlated with traces and logs",
			"OpenTelemetry-native, ClickHouse-backed",
			"Clean search-first UX",
		],
		cons: ["Younger project, smaller community", "Fewer prebuilt integrations than incumbents"],
	},
	{
		rank: 5,
		name: "OpenObserve",
		slug: "openobserve",
		url: "https://openobserve.ai/",
		bestFor: "Cost-sensitive teams with very high log volume",
		license: "AGPLv3",
		summary:
			"OpenObserve is a Rust-based observability platform designed for cheap, S3-backed storage at high volume. It shines for logs and is simple to run, with traces and metrics support that's maturing.",
		pros: [
			"Very low storage cost (object storage / S3)",
			"Fast and simple to operate",
			"Strong logs experience",
		],
		cons: ["Tracing and metrics less mature than logs", "Smaller community than Grafana or SigNoz"],
	},
	{
		rank: 6,
		name: "Uptrace",
		slug: "uptrace",
		url: "https://uptrace.dev/",
		bestFor: "A lightweight OpenTelemetry APM on a budget",
		license: "Source-available (BSL → Apache 2.0)",
		summary:
			"Uptrace is a lightweight, OpenTelemetry-native APM backed by ClickHouse, covering traces, logs, and metrics. It's easy to stand up for smaller deployments that want OTel support without much operational weight.",
		pros: [
			"OpenTelemetry-native, ClickHouse-backed",
			"Lightweight and quick to deploy",
			"Unified traces, logs, and metrics",
		],
		cons: [
			"Source-available (BSL), not OSI open source",
			"Smaller ecosystem and team than larger projects",
		],
	},
	{
		rank: 7,
		name: "Jaeger + Prometheus",
		slug: "jaeger-prometheus",
		url: "https://www.jaegertracing.io/",
		bestFor: "CNCF-native teams that want battle-tested tracing and metrics",
		license: "Apache 2.0 (CNCF)",
		summary:
			"Jaeger (tracing) and Prometheus (metrics) are CNCF-graduated, ubiquitous, and free. Together they're a proven foundation, but they're two separate tools with no unified logs, so you build and operate the glue yourself.",
		pros: [
			"CNCF-graduated and battle-tested",
			"Ubiquitous in Kubernetes environments",
			"Completely free and vendor-neutral",
		],
		cons: [
			"Two+ separate tools, no unified logs",
			"You assemble dashboards and storage (Cassandra/Elasticsearch, etc.)",
			"No built-in correlation across signals",
		],
	},
]

export const listicleFaqs: Array<{ question: string; answer: string }> = [
	{
		question: "What is the best open-source observability tool in 2026?",
		answer: "There's no single winner — it depends on how your team works. Maple is the strongest fit for OpenTelemetry-native teams that want AI-agent (MCP) workflows and usage-based pricing; Grafana's LGTM stack is best when you want maximum flexibility and don't mind operating several components; SigNoz is a great all-in-one OTel-native APM. Match the tool to the “Best for” line rather than the rank.",
	},
	{
		question: "Are open-source observability platforms production-ready?",
		answer: "Yes. Several are CNCF-graduated (Jaeger, Prometheus) and others run large production workloads today. Open source here means you can self-host, audit the code, and avoid vendor lock-in — not that the tools are experimental.",
	},
	{
		question: "Why does OpenTelemetry matter when choosing an observability tool?",
		answer: "OpenTelemetry is the vendor-neutral standard for traces, logs, and metrics. Instrumenting with OpenTelemetry means you can switch backends without re-instrumenting your code, so OTel-native tools like Maple, SigNoz, and Uptrace avoid the lock-in of proprietary agents.",
	},
	{
		question: "Can I self-host all of these tools?",
		answer: "Yes — every tool in this roundup can be self-hosted. Maple, SigNoz, HyperDX, and Uptrace are ClickHouse-backed; the Grafana stack uses Loki/Tempo/Mimir; Jaeger and Prometheus are CNCF projects. Several also offer a managed cloud option if you'd rather not run the infrastructure.",
	},
	{
		question: "Is open-source observability cheaper than SaaS tools like Datadog?",
		answer: "Often, yes — especially at scale, where SaaS per-host and per-GB pricing compounds. Self-hosting trades software fees for infrastructure and operational time. Tools with usage-based pricing or cheap object storage (Maple, OpenObserve) keep costs predictable without you operating everything yourself.",
	},
	{
		question: "Which open-source tool is best for AI agents?",
		answer: "Maple ships a first-class MCP (Model Context Protocol) server, so compatible AI agents can list services, search traces, find errors, and propose fixes against your telemetry from one backend. Grafana also offers an official MCP server for its stack; with the LGTM setup the agent works across separate data stores.",
	},
]
