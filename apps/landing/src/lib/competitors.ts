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
			"Maple gives you the same distributed tracing, log management, and metrics dashboards as Datadog — built on OpenTelemetry with transparent usage-based pricing and no vendor lock-in.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Complex per-host + per-GB",
			},
			"Open source": {
				maple: true,
				competitor: false,
			},
			"OpenTelemetry native": {
				maple: true,
				competitor: false,
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
				competitor: false,
			},
			"Self-hosting available": {
				maple: true,
				competitor: false,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: false,
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
				competitor: "Hours to days",
			},
			"Proprietary agents required": {
				maple: false,
				competitor: true,
			},
			"Data retention control": {
				maple: true,
				competitor: false,
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
				answer: "Maple uses transparent, usage-based pricing based on data volume — no per-host fees, no per-seat charges, no separate costs for custom metrics. Datadog's pricing combines per-host, per-GB, and per-feature charges that can lead to unexpected bills as you scale. Most teams see significant cost savings with Maple.",
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
				label: "Open source",
				detail: "Every line of code is open — audit, contribute, and self-host freely",
			},
			{
				value: "$0",
				label: "Per-seat cost",
				detail: "Unlimited team members included. No per-seat pricing, ever",
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
				maple: true,
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
				competitor: false,
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
				answer: "Grafana Cloud manages the Loki/Tempo/Mimir stack for you but you're still working with multiple query languages and separate data stores. Maple provides a unified experience where all signals are correlated automatically — plus AI-powered diagnostics and MCP integration that Grafana doesn't offer.",
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
			"Maple provides the same full-stack observability as New Relic — traces, logs, and metrics — with OpenTelemetry-native ingestion, no per-seat fees, and the freedom to self-host.",
		features: {
			"Pricing model": {
				maple: "Usage-based, transparent",
				competitor: "Per-seat + per-GB",
			},
			"Open source": {
				maple: true,
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
				competitor: false,
			},
			"Self-hosting available": {
				maple: true,
				competitor: false,
			},
			"No vendor lock-in": {
				maple: true,
				competitor: false,
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
				maple: true,
				competitor: false,
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
				answer: "Maple covers the core observability features: distributed tracing, log management, metrics dashboards, alerting, and AI-powered diagnostics. If you're using New Relic primarily for APM, logs, and infrastructure monitoring, Maple handles those use cases. Advanced New Relic features like Browser Monitoring and Synthetics are not yet available.",
			},
			{
				question: "How much can I save by switching from New Relic to Maple?",
				answer: "Savings depend on your team size and data volume. New Relic charges per full-platform user (and per GB of data beyond the free tier). Maple charges only for data volume with unlimited seats — so the more engineers you have, the more you save. Teams with 10+ users typically see significant reductions.",
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
				detail: "Unlimited team members — no per-user fees to limit observability access",
			},
			{
				value: "100%",
				label: "Open source",
				detail: "Inspect every line of code. No black-box data processing",
			},
			{
				value: "0",
				label: "Proprietary agents",
				detail: "Pure OpenTelemetry — no vendor-specific agents to install or maintain",
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
