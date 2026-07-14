export interface CompetitorFeature {
	maple: string | boolean
	competitor: string | boolean
}

export interface PainPoint {
	problem: string
	solution: string
}

export interface MigrationStep {
	title: string
	description: string
}

export interface FAQ {
	question: string
	answer: string
}

export interface Stat {
	value: string
	label: string
	detail: string
}

export interface Competitor {
	name: string
	slug: string
	tagline: string
	description: string
	features: Record<string, CompetitorFeature>
	painPoints: PainPoint[]
	migrationSteps: MigrationStep[]
	faqs: FAQ[]
	stats: Stat[]
}

export const competitors: Record<string, Competitor> = {
	datadog: {
		name: "Datadog",
		slug: "datadog",
		tagline: "Open-source observability without the surprise bills",
		description:
			"Maple covers the core observability workflow — distributed tracing, log management, and metrics dashboards — built on OpenTelemetry with a flat per-GB rate and source code you can read.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Complex per-host + per-GB",
			},
			"Open source": {
				maple: "FSL-1.1 → Apache 2.0",
				competitor: false,
			},
			"OpenTelemetry native": {
				maple: true,
				competitor: "OTLP ingest via Datadog Agent",
			},
			"Distributed tracing": {
				maple: true,
				competitor: true,
			},
			"Log management": {
				maple: true,
				competitor: true,
			},
			"Metrics & dashboards": {
				maple: true,
				competitor: true,
			},
			"AI / MCP integration": {
				maple: true,
				competitor: true,
			},
			"Self-hosting available": {
				maple: true,
				competitor: false,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: "Proprietary agent by default",
			},
			"Custom dashboards": {
				maple: true,
				competitor: true,
			},
			Alerting: {
				maple: true,
				competitor: true,
			},
			"Setup time": {
				maple: "Minutes",
				competitor: "Agent rollout per host",
			},
			"Proprietary agents required": {
				maple: false,
				competitor: true,
			},
			"Data retention control": {
				maple: "Configurable",
				competitor: "Fixed tiers per product",
			},
			"Team seats included": {
				maple: "Unlimited",
				competitor: "Per-seat pricing",
			},
			"API-first design": {
				maple: true,
				competitor: true,
			},
		},
		painPoints: [
			{
				problem: "Unpredictable billing that spikes with traffic",
				solution:
					"Transparent usage-based pricing — you always know what you'll pay before you scale.",
			},
			{
				problem: "Proprietary agent lock-in ties your instrumentation to one vendor",
				solution: "100% OpenTelemetry native. Your instrumentation is portable and vendor-neutral.",
			},
			{
				problem: "Complex pricing tiers across hosts, containers, custom metrics, and log volume",
				solution:
					"One simple pricing model based on data volume. No per-host fees, no hidden surcharges.",
			},
			{
				problem: "No option to self-host or keep data within your own infrastructure",
				solution:
					"Self-host Maple on your own infrastructure for full data sovereignty and compliance.",
			},
		],
		migrationSteps: [
			{
				title: "Keep your existing OTel instrumentation",
				description:
					"If you already use OpenTelemetry SDKs alongside the Datadog agent, just point the OTLP exporter to Maple. No code changes needed for OTel-instrumented services.",
			},
			{
				title: "Replace the Datadog agent with the OTel Collector",
				description:
					"Swap the proprietary Datadog agent for the open-source OpenTelemetry Collector. Configure it to export to Maple's OTLP endpoint.",
			},
			{
				title: "Rebuild dashboards and alerts in Maple",
				description:
					"Use Maple's dashboard builder and alerting system to recreate your monitoring views. AI-assisted setup helps you get started faster.",
			},
		],
		faqs: [
			{
				question: "Is Maple a drop-in replacement for Datadog?",
				answer: "Maple covers the core observability features most teams use: distributed tracing, log management, metrics dashboards, alerting, and AI-powered diagnostics. If your workflow centers on traces, logs, and metrics, Maple can replace Datadog for those use cases. Some advanced Datadog-specific features like Synthetic Monitoring or Network Performance Monitoring are not yet available.",
			},
			{
				question: "How does Maple's pricing compare to Datadog?",
				answer: "Maple charges a flat rate per GB of ingested data — no per-host fees, no per-seat charges, no separate costs for custom metrics. Datadog's list pricing combines per-host, per-GB, and per-feature charges. Whether you save depends on your host count and data volume; the pricing calculator compares both on your actual numbers.",
			},
			{
				question: "Can I migrate from Datadog to Maple without downtime?",
				answer: "Yes. You can run Maple alongside Datadog during migration by dual-shipping your telemetry data. Point your OpenTelemetry Collector at both backends, verify your data in Maple, then cut over when ready.",
			},
			{
				question: "Does Maple support the Datadog agent?",
				answer: "Maple does not use proprietary agents. Instead, it's built on OpenTelemetry — the open standard for observability. You'll replace the Datadog agent with the open-source OpenTelemetry Collector, which gives you vendor-neutral instrumentation that works with any OTel-compatible backend.",
			},
			{
				question: "Can I self-host Maple instead of using the cloud version?",
				answer: "Yes. Maple's source is available under FSL-1.1 and can be self-hosted on your own infrastructure. This gives you complete control over your data, compliance with data residency requirements, and eliminates ongoing SaaS costs.",
			},
			{
				question: "Does Maple have AI-powered features like Datadog?",
				answer: "Maple includes AI-powered diagnostics and an MCP (Model Context Protocol) integration that lets AI agents query your observability data directly. This enables automated root cause analysis, anomaly detection, and conversational debugging workflows that go beyond traditional dashboards.",
			},
		],
		stats: [
			{
				value: "5 min",
				label: "Setup time",
				detail: "From zero to ingesting traces, logs, and metrics with OpenTelemetry",
			},
			{
				value: "100%",
				label: "Source on GitHub",
				detail: "FSL-1.1, converting to Apache 2.0 — audit it, fork it, self-host it",
			},
			{
				value: "$0",
				label: "Per-seat cost",
				detail: "No per-seat pricing on any plan — every engineer gets access",
			},
		],
	},
	grafana: {
		name: "Grafana",
		slug: "grafana",
		tagline: "The simplicity of Grafana with zero configuration overhead",
		description:
			"Maple delivers the open-source flexibility of Grafana Cloud with a purpose-built OpenTelemetry backend — no Prometheus, Loki, or Tempo stack to configure and maintain.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Usage-based + self-host costs",
			},
			"Open source": {
				maple: "FSL-1.1 → Apache 2.0",
				competitor: true,
			},
			"OpenTelemetry native": {
				maple: true,
				competitor: true,
			},
			"Distributed tracing": {
				maple: true,
				competitor: true,
			},
			"Log management": {
				maple: true,
				competitor: true,
			},
			"Metrics & dashboards": {
				maple: true,
				competitor: true,
			},
			"AI / MCP integration": {
				maple: true,
				competitor: true,
			},
			"Self-hosting available": {
				maple: true,
				competitor: true,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: true,
			},
			"Custom dashboards": {
				maple: true,
				competitor: true,
			},
			Alerting: {
				maple: true,
				competitor: true,
			},
			"Setup time": {
				maple: "Minutes",
				competitor: "Hours (multi-tool config)",
			},
			"Proprietary agents required": {
				maple: false,
				competitor: false,
			},
			"Data retention control": {
				maple: true,
				competitor: true,
			},
			"Team seats included": {
				maple: "Unlimited",
				competitor: "Varies by plan",
			},
			"API-first design": {
				maple: true,
				competitor: true,
			},
		},
		painPoints: [
			{
				problem: "Managing separate backends for Loki, Tempo, Mimir, and Prometheus",
				solution:
					"One unified platform handles traces, logs, and metrics. No stack to assemble or maintain.",
			},
			{
				problem: "Hours of configuration before you can ingest your first trace",
				solution:
					"Point your OTel Collector at Maple and start seeing data in minutes. Zero configuration required.",
			},
			{
				problem: "Learning PromQL, LogQL, and TraceQL — three different query languages",
				solution:
					"A single, intuitive query interface across all signal types. No query language fragmentation.",
			},
			{
				problem: "Scaling each backend independently with different resource requirements",
				solution:
					"Maple scales as one system. Built on ClickHouse for high-throughput ingestion and fast queries at any scale.",
			},
		],
		migrationSteps: [
			{
				title: "Point your OTel Collector to Maple",
				description:
					"If you're already using the OpenTelemetry Collector with Grafana backends, just change the OTLP exporter endpoint to Maple. Your instrumentation stays the same.",
			},
			{
				title: "Migrate dashboards to Maple's builder",
				description:
					"Recreate your Grafana dashboards using Maple's drag-and-drop dashboard builder. Most teams find the setup faster since data sources are pre-connected.",
			},
			{
				title: "Decommission the Grafana stack",
				description:
					"Once verified, shut down Loki, Tempo, Mimir, and Prometheus. You've just replaced five services with one.",
			},
		],
		faqs: [
			{
				question: "Is Maple a replacement for the entire Grafana stack?",
				answer: "Yes. Maple replaces the combination of Grafana (visualization), Loki (logs), Tempo (traces), and Mimir/Prometheus (metrics) with a single unified platform. You get traces, logs, metrics, dashboards, and alerting in one system.",
			},
			{
				question: "How does Maple compare to Grafana Cloud?",
				answer: "Grafana Cloud manages the Loki/Tempo/Mimir stack for you, but you're still working with multiple query languages and separate data stores. Maple stores all three signals in one database, so traces, logs, and metrics are correlated automatically instead of joined across backends.",
			},
			{
				question: "Do I need to learn a new query language?",
				answer: "No. Maple provides an intuitive visual query builder and search interface. Unlike Grafana where you need to learn PromQL for metrics, LogQL for logs, and TraceQL for traces, Maple uses a single query approach across all signal types.",
			},
			{
				question: "Can I still self-host with Maple like I can with Grafana?",
				answer: "Yes. Maple's source is available under FSL-1.1 and can be self-hosted. The difference is you're deploying one system instead of four or five separate components.",
			},
			{
				question: "What about Grafana's plugin ecosystem?",
				answer: "Maple focuses on the core observability experience: traces, logs, metrics, dashboards, alerting, and AI. While it doesn't have Grafana's extensive plugin ecosystem, most teams find they don't need it — the built-in features cover the standard observability workflow without additional configuration.",
			},
			{
				question: "Is Maple built on OpenTelemetry like Grafana Tempo?",
				answer: "Yes, but Maple goes further. The entire platform is built for OpenTelemetry from the ground up — not just the tracing backend. Traces, logs, and metrics all flow through standard OTLP ingestion, giving you a consistent, vendor-neutral pipeline.",
			},
		],
		stats: [
			{
				value: "1",
				label: "System to manage",
				detail: "Replace Loki, Tempo, Mimir, Prometheus, and Grafana with one platform",
			},
			{
				value: "0",
				label: "Query languages to learn",
				detail: "Visual query builder instead of PromQL, LogQL, and TraceQL",
			},
			{
				value: "5 min",
				label: "To first data",
				detail: "From OTel Collector config to seeing traces, logs, and metrics",
			},
		],
	},
	"new-relic": {
		name: "New Relic",
		slug: "new-relic",
		tagline: "Full-stack observability without per-seat pricing",
		description:
			"Maple covers the observability core — traces, logs, and metrics — with OpenTelemetry-native ingestion, no per-seat fees, and the freedom to self-host.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Per-seat + per-GB",
			},
			"Open source": {
				maple: "FSL-1.1 → Apache 2.0",
				competitor: false,
			},
			"OpenTelemetry native": {
				maple: true,
				competitor: true,
			},
			"Distributed tracing": {
				maple: true,
				competitor: true,
			},
			"Log management": {
				maple: true,
				competitor: true,
			},
			"Metrics & dashboards": {
				maple: true,
				competitor: true,
			},
			"AI / MCP integration": {
				maple: true,
				competitor: true,
			},
			"Self-hosting available": {
				maple: true,
				competitor: false,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: "Proprietary agents, NRQL",
			},
			"Custom dashboards": {
				maple: true,
				competitor: true,
			},
			Alerting: {
				maple: true,
				competitor: true,
			},
			"Setup time": {
				maple: "Minutes",
				competitor: "Moderate",
			},
			"Proprietary agents required": {
				maple: false,
				competitor: true,
			},
			"Data retention control": {
				maple: "Configurable",
				competitor: "Extended retention costs extra",
			},
			"Team seats included": {
				maple: "Unlimited",
				competitor: "Per-seat pricing",
			},
			"API-first design": {
				maple: true,
				competitor: true,
			},
		},
		painPoints: [
			{
				problem: "Per-seat pricing limits observability access to a few engineers",
				solution:
					"Unlimited team seats included. Every engineer, on-call responder, and manager gets access.",
			},
			{
				problem: "Closed-source platform means no visibility into how your data is processed",
				solution:
					"Maple's source is available under FSL-1.1. Audit the code, understand the data pipeline, and contribute back.",
			},
			{
				problem: "Vendor lock-in through proprietary agents and NRQL query language",
				solution:
					"Built on OpenTelemetry standards. Your instrumentation and data remain portable to any OTel backend.",
			},
			{
				problem: "No option to self-host or meet data residency requirements on your own terms",
				solution:
					"Self-host Maple on your own infrastructure for complete control over data storage and compliance.",
			},
		],
		migrationSteps: [
			{
				title: "Switch from New Relic agents to OpenTelemetry",
				description:
					"Replace New Relic's proprietary agents with OpenTelemetry SDKs. OTel provides the same auto-instrumentation for popular frameworks and languages.",
			},
			{
				title: "Point OTLP exports to Maple",
				description:
					"Configure your OpenTelemetry Collector or SDK to export to Maple's OTLP endpoint. You can dual-ship to both New Relic and Maple during the transition.",
			},
			{
				title: "Set up dashboards and alerts",
				description:
					"Build your monitoring views in Maple's dashboard builder. Set up alerting rules to match your existing New Relic alert policies.",
			},
		],
		faqs: [
			{
				question: "Is Maple a full replacement for New Relic?",
				answer: "Maple covers the core observability features: distributed tracing, log management, metrics dashboards, alerting, and AI-powered diagnostics. If you're using New Relic primarily for APM, logs, and infrastructure monitoring, Maple handles those use cases. For browser-side visibility Maple offers session replay correlated with backend traces rather than full RUM; Synthetics has no Maple equivalent yet.",
			},
			{
				question: "How much can I save by switching from New Relic to Maple?",
				answer: "Savings depend on your team size and data volume. New Relic's list price charges per full-platform user plus per GB of data beyond the free tier. Maple charges only for data volume, with no seat fees — so the difference grows with the number of engineers who need access. Run both through the pricing calculator on your actual numbers.",
			},
			{
				question: "Does Maple support NRQL or a similar query language?",
				answer: "Maple provides a visual query builder and search interface instead of a proprietary query language like NRQL. This means no learning curve and no lock-in to a vendor-specific syntax. For advanced queries, you can use the API.",
			},
			{
				question: "Can I run New Relic and Maple side by side during migration?",
				answer: "Yes. Dual-ship your telemetry data by configuring the OpenTelemetry Collector to export to both New Relic and Maple simultaneously. Verify your data in Maple, then decommission New Relic when ready.",
			},
			{
				question: "Is Maple open source? Can I self-host it?",
				answer: "Yes to both. Maple's source is available under FSL-1.1. You can self-host it on your own infrastructure for complete data sovereignty, or use the hosted cloud version at app.maple.dev.",
			},
			{
				question: "How does Maple's AI compare to New Relic AI?",
				answer: "Maple includes AI-powered diagnostics and an MCP (Model Context Protocol) integration that lets AI agents query your observability data directly. This enables automated root cause analysis and conversational debugging that integrates with your existing AI workflow tools.",
			},
		],
		stats: [
			{
				value: "$0",
				label: "Per-seat cost",
				detail: "No per-user fees to limit observability access",
			},
			{
				value: "100%",
				label: "Source on GitHub",
				detail: "FSL-1.1, converting to Apache 2.0 — no black-box data processing",
			},
			{
				value: "0",
				label: "Proprietary agents",
				detail: "Pure OpenTelemetry — no vendor-specific agents to install or maintain",
			},
		],
	},
	dash0: {
		name: "Dash0",
		slug: "dash0",
		tagline: "OpenTelemetry-native observability you can actually own",
		description:
			"Dash0 and Maple are both OpenTelemetry-native with transparent usage-based pricing and no per-seat fees. The difference is ownership: Maple is open source and self-hostable, so you can run it on your own infrastructure — including your own ClickHouse — for full data sovereignty and retention control, instead of a closed SaaS backend.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Usage-based, transparent",
			},
			"Open source": {
				maple: "FSL-1.1 → Apache 2.0",
				competitor: false,
			},
			"OpenTelemetry native": {
				maple: true,
				competitor: true,
			},
			"Distributed tracing": {
				maple: true,
				competitor: true,
			},
			"Log management": {
				maple: true,
				competitor: true,
			},
			"Metrics & dashboards": {
				maple: true,
				competitor: true,
			},
			"AI / MCP integration": {
				maple: true,
				competitor: true,
			},
			"Self-hosting available": {
				maple: true,
				competitor: false,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: true,
			},
			"Custom dashboards": {
				maple: true,
				competitor: true,
			},
			Alerting: {
				maple: true,
				competitor: true,
			},
			"Setup time": {
				maple: "Minutes",
				competitor: "Minutes",
			},
			"Proprietary agents required": {
				maple: false,
				competitor: false,
			},
			"Data retention control": {
				maple: "Configurable",
				competitor: "Fixed periods",
			},
			"Team seats included": {
				maple: "Unlimited",
				competitor: "No per-seat fees",
			},
			"API-first design": {
				maple: true,
				competitor: true,
			},
		},
		painPoints: [
			{
				problem: "Closed-source SaaS backend — no way to audit how your telemetry is processed",
				solution:
					"Maple's source is available under FSL-1.1. Inspect every line, contribute features, and trust there are no black boxes.",
			},
			{
				problem: "No self-hosting option — your telemetry has to live in Dash0's cloud",
				solution:
					"Self-host Maple on your own infrastructure to meet data residency and compliance requirements and keep telemetry inside your own perimeter.",
			},
			{
				problem: "Fixed retention windows you can't tune to your own needs",
				solution:
					"Self-hosting puts you in control of retention and storage — keep data as long as your compliance and debugging workflows require.",
			},
			{
				problem: "SaaS-only means an ongoing subscription with no escape hatch",
				solution:
					"Run Maple on infrastructure you already own to eliminate per-data SaaS fees — or use the hosted version when you'd rather not operate it.",
			},
		],
		migrationSteps: [
			{
				title: "Keep your OpenTelemetry instrumentation",
				description:
					"Both Dash0 and Maple ingest standard OTLP, so your existing SDKs, auto-instrumentation, and semantic conventions carry over unchanged. Nothing to rewrite.",
			},
			{
				title: "Re-point your OTel Collector exporter",
				description:
					"Change the OTLP exporter endpoint from Dash0 to Maple — or dual-ship to both during the transition to verify your data lands correctly.",
			},
			{
				title: "Recreate dashboards and alerts",
				description:
					"Rebuild your monitoring views in Maple's dashboard builder and set up alerting rules. AI-assisted setup helps you get there faster.",
			},
		],
		faqs: [
			{
				question: "How is Maple different from Dash0?",
				answer: "The fundamentals are similar — both are OpenTelemetry-native, both have transparent usage-based pricing with no per-seat fees, and both offer an MCP integration for AI agents. The real difference is ownership: Maple is open source (FSL-1.1) and self-hostable on your own infrastructure, including your own ClickHouse, with full control over data retention and residency. Dash0 is a closed-source, SaaS-only backend.",
			},
			{
				question: "Is Maple open source? Can I self-host it?",
				answer: "Yes to both. Maple's source is available under the Functional Source License (FSL-1.1) and can be self-hosted on your own infrastructure for full data sovereignty and compliance. Dash0's observability backend is closed-source and SaaS-only with no self-hosting — they do open-source client-side tooling like their OpenTelemetry distribution and Kubernetes operator, but not the platform itself.",
			},
			{
				question: "How hard is it to migrate from Dash0 to Maple?",
				answer: "Moving the telemetry pipeline is about as easy as it gets: since both platforms ingest standard OTLP, you just re-point your OpenTelemetry Collector's exporter at Maple's endpoint — no instrumentation changes. You can dual-ship to both backends during the transition. Dashboards, saved views, and alert rules don't transfer over OTLP, so plan to recreate those in Maple.",
			},
			{
				question: "Can I keep my telemetry on my own infrastructure?",
				answer: "Yes — self-host Maple for full data residency and sovereignty, which is useful for compliance requirements that keep data inside your own perimeter. Dash0 is SaaS-only, so your telemetry lives in their cloud. Maple also offers a hosted version if you'd rather not operate it yourself.",
			},
			{
				question: "How does Maple's pricing compare to Dash0?",
				answer: "Both use transparent, usage-based pricing and neither charges per seat, so the models are comparable (Dash0 bills per data point; Maple bills per GB of ingested data). The main lever Maple gives you is self-hosting: run it on infrastructure you already own and you pay for compute and storage instead of per-data SaaS fees.",
			},
			{
				question: "Will my OpenTelemetry instrumentation work with Maple?",
				answer: "Yes. Maple is built for OpenTelemetry from the ground up and ingests standard OTLP for traces, logs, and metrics. Any instrumentation that already works with Dash0 works with Maple unchanged — your pipeline stays vendor-neutral.",
			},
		],
		stats: [
			{
				value: "100%",
				label: "Open source",
				detail: "Source-available under FSL-1.1 — audit, contribute, and self-host freely",
			},
			{
				value: "1",
				label: "Config change to migrate",
				detail: "Both are OTLP-native — just re-point your OTel Collector exporter",
			},
			{
				value: "Yes",
				label: "Self-hostable",
				detail: "Run Maple on your own infrastructure, including your own ClickHouse — Dash0 is SaaS-only",
			},
		],
	},
}

export const featureCategories = [
	{
		name: "Core Observability",
		features: [
			"Distributed tracing",
			"Log management",
			"Metrics & dashboards",
			"Custom dashboards",
			"Alerting",
		],
	},
	{
		name: "Platform & Architecture",
		features: [
			"OpenTelemetry native",
			"Open source",
			"Self-hosting available",
			"No vendor lock-in",
			"AI / MCP integration",
			"API-first design",
		],
	},
	{
		name: "Pricing & Access",
		features: [
			"Pricing model",
			"Team seats included",
			"Setup time",
			"Proprietary agents required",
			"Data retention control",
		],
	},
] as const

export const featureOrder = [
	"Pricing model",
	"Open source",
	"OpenTelemetry native",
	"Distributed tracing",
	"Log management",
	"Metrics & dashboards",
	"AI / MCP integration",
	"Self-hosting available",
	"No vendor lock-in",
	"Custom dashboards",
	"Alerting",
] as const
