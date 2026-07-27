/**
 * The feature-page registry. One entry per `/features/<slug>` route, in all
 * three locales.
 *
 * Read `page-registry.ts` first — messages are stored uncalled, and this file
 * must not import `.astro` or `astro:i18n` (NavBar is a client island that
 * reads it).
 *
 * Screenshot allocation: no capture anchors more than two pages, homepage
 * included. Where two pages wanted the same shot, the one whose argument needs
 * it keeps it and the other takes a live artifact — `service-catalog` gives up
 * `surface-map` to `microservices-debugging` and gets `LiveServiceMap`;
 * `distributed-tracing` takes `hero-traces` (3600 w) over `flow-02-trace`.
 * `flow-04-agent` stays homepage-only: at 1984 w it renders soft on a plate.
 *
 * `related` is hand-picked rather than derived. The old RelatedFeatures did
 * `filter().slice(0, 3)` over one array, which sent every page to the same
 * first three slugs and left four features with no inbound links at all. Each
 * slug below appears in at least two others' lists.
 */
import * as m from "../paraglide/messages"
import type { Feature } from "./page-registry"

export const features: Feature[] = [
	{
		slug: "distributed-tracing",
		navLabel: m.nav_distributed_tracing,
		navDesc: m.nav_desc_distributed_tracing,
		seoTitle: m.feat_tracing_seo_title,
		seoDescription: m.feat_tracing_seo_desc,
		heroTitle: m.feat_tracing_hero_title,
		heroLede: m.feat_tracing_hero_lede,
		panel: {
			route: "/traces",
			constant: "trace 4f9ac21e…8b7d40f2",
			plate: {
				src: "/screenshots/hero-traces.webp",
				width: 3600,
				height: 1850,
				alt: "A slow database span selected in an 18-span waterfall, with its query attributes open alongside",
			},
			facts: [
				{ key: "signal", value: "traces" },
				{ key: "transport", value: "OTLP/gRPC · OTLP/HTTP" },
				{ key: "views", value: "waterfall · flamegraph · flow" },
				{ key: "attributes", value: "db.statement · http.status_code · exception.type" },
				{ key: "joins.on", value: "trace_id · span_id" },
				{ key: "sampling", value: "head · tail" },
			],
			title: m.feat_tracing_panel_title,
			lede: m.feat_tracing_panel_lede,
		},
		artifact: {
			id: "trace-visualization",
			title: m.feat_tracing_artifact_title,
			lede: m.feat_tracing_artifact_lede,
			wide: true,
		},
		extraSections: [],
		capTitle: m.feat_tracing_cap_title,
		capabilities: [
			{ op: "/traces", title: m.feat_tracing_cap_1_title, body: m.feat_tracing_cap_1_body },
			{ op: "flamegraph", title: m.feat_tracing_cap_2_title, body: m.feat_tracing_cap_2_body },
			{ op: "flow view", title: m.feat_tracing_cap_3_title, body: m.feat_tracing_cap_3_body },
			{ op: "db.statement", title: m.feat_tracing_cap_4_title, body: m.feat_tracing_cap_4_body },
			{ op: "trace_id", title: m.feat_tracing_cap_5_title, body: m.feat_tracing_cap_5_body },
		],
		related: ["service-catalog", "log-management", "error-tracking"],
		relatedUseCases: ["microservices-debugging"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "browser-sessions",
		navLabel: m.nav_browser_sessions,
		navDesc: m.nav_desc_browser_sessions,
		seoTitle: m.feat_sessions_seo_title,
		seoDescription: m.feat_sessions_seo_desc,
		heroTitle: m.feat_sessions_hero_title,
		heroLede: m.feat_sessions_hero_lede,
		panel: {
			route: "/replays",
			constant: "session s_9f31 · 6:12",
			plate: {
				src: "/screenshots/strip-session.webp",
				width: 2976,
				height: 1800,
				alt: "A session replay with the recorded viewport playing beside its console, network and error tabs",
			},
			facts: [
				{ key: "signal", value: "sessions" },
				{ key: "records", value: "DOM · console · network · errors" },
				{ key: "joins.on", value: "session_id · trace_id" },
				{ key: "masking", value: "input · text · client-side" },
				{ key: "sampling", value: "per org" },
			],
			title: m.feat_sessions_panel_title,
			lede: m.feat_sessions_panel_lede,
		},
		artifact: {
			id: "browser-sessions",
			title: m.feat_sessions_artifact_title,
			lede: m.feat_sessions_artifact_lede,
			wide: true,
		},
		extraSections: [],
		capTitle: m.feat_sessions_cap_title,
		capabilities: [
			{ op: "event stream", title: m.feat_sessions_cap_1_title, body: m.feat_sessions_cap_1_body },
			{ op: "rrweb", title: m.feat_sessions_cap_2_title, body: m.feat_sessions_cap_2_body },
			{ op: "session_id", title: m.feat_sessions_cap_3_title, body: m.feat_sessions_cap_3_body },
			{ op: "http.status_code", title: m.feat_sessions_cap_4_title, body: m.feat_sessions_cap_4_body },
			{ op: "mask rules", title: m.feat_sessions_cap_5_title, body: m.feat_sessions_cap_5_body },
		],
		related: ["distributed-tracing", "error-tracking", "log-management"],
		relatedUseCases: ["ecommerce-observability"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "log-management",
		navLabel: m.nav_log_management,
		navDesc: m.nav_desc_log_management,
		seoTitle: m.feat_logs_seo_title,
		seoDescription: m.feat_logs_seo_desc,
		heroTitle: m.feat_logs_hero_title,
		heroLede: m.feat_logs_hero_lede,
		panel: {
			route: "/logs",
			constant: "severity >= WARN",
			plate: {
				src: "/screenshots/strip-logs.webp",
				width: 2976,
				height: 1800,
				alt: "Structured log search with severity facets and attribute filters down the left rail",
			},
			facts: [
				{ key: "signal", value: "logs" },
				{ key: "transport", value: "OTLP · no agent" },
				{ key: "severity", value: "TRACE · DEBUG · INFO · WARN · ERROR · FATAL" },
				{ key: "filters", value: "body · resource.* · log.*" },
				{ key: "joins.on", value: "trace_id · span_id" },
				{ key: "buckets", value: "5 min" },
			],
			title: m.feat_logs_panel_title,
			lede: m.feat_logs_panel_lede,
		},
		artifact: {
			id: "log-stream",
			title: m.feat_logs_artifact_title,
			lede: m.feat_logs_artifact_lede,
		},
		extraSections: [],
		capTitle: m.feat_logs_cap_title,
		capabilities: [
			{ op: "/logs?q=", title: m.feat_logs_cap_1_title, body: m.feat_logs_cap_1_body },
			{ op: "severity", title: m.feat_logs_cap_2_title, body: m.feat_logs_cap_2_body },
			{ op: "trace_id", title: m.feat_logs_cap_3_title, body: m.feat_logs_cap_3_body },
			{ op: "volume histogram", title: m.feat_logs_cap_4_title, body: m.feat_logs_cap_4_body },
			{ op: "OTLP", title: m.feat_logs_cap_5_title, body: m.feat_logs_cap_5_body },
		],
		related: ["distributed-tracing", "error-tracking", "metrics-dashboards"],
		relatedUseCases: ["ecommerce-observability"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "metrics-dashboards",
		navLabel: m.nav_metrics_dashboards,
		navDesc: m.nav_desc_metrics_dashboards,
		seoTitle: m.feat_metrics_seo_title,
		seoDescription: m.feat_metrics_seo_desc,
		heroTitle: m.feat_metrics_hero_title,
		heroLede: m.feat_metrics_hero_lede,
		panel: {
			route: "/metrics",
			constant: "http.server.request.duration",
			plate: {
				src: "/screenshots/surface-metrics.webp",
				width: 2560,
				height: 1320,
				alt: "The metric explorer listing every metric with its type and cardinality",
			},
			facts: [
				{ key: "signal", value: "metrics" },
				{ key: "temporality", value: "delta · cumulative" },
				{ key: "widgets", value: "series · stat · table · histogram" },
				{ key: "percentiles", value: "p50 · p95 · p99" },
				{ key: "variables", value: "$service · $env" },
			],
			title: m.feat_metrics_panel_title,
			lede: m.feat_metrics_panel_lede,
		},
		artifact: {
			id: "logs-volume",
			title: m.feat_metrics_artifact_title,
			lede: m.feat_metrics_artifact_lede,
		},
		extraSections: [],
		capTitle: m.feat_metrics_cap_title,
		capabilities: [
			{ op: "time series", title: m.feat_metrics_cap_1_title, body: m.feat_metrics_cap_1_body },
			{ op: "stat + threshold", title: m.feat_metrics_cap_2_title, body: m.feat_metrics_cap_2_body },
			{ op: "$service", title: m.feat_metrics_cap_3_title, body: m.feat_metrics_cap_3_body },
			{ op: "group by", title: m.feat_metrics_cap_4_title, body: m.feat_metrics_cap_4_body },
			{ op: "select range", title: m.feat_metrics_cap_5_title, body: m.feat_metrics_cap_5_body },
		],
		related: ["service-catalog", "log-management", "kubernetes-monitoring"],
		relatedUseCases: ["api-performance"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "service-catalog",
		navLabel: m.nav_service_catalog,
		navDesc: m.nav_desc_service_catalog,
		seoTitle: m.feat_catalog_seo_title,
		seoDescription: m.feat_catalog_seo_desc,
		heroTitle: m.feat_catalog_hero_title,
		heroLede: m.feat_catalog_hero_lede,
		panel: {
			route: "/services",
			constant: "12 services · env production",
			plate: {
				// 2974×2122 is this capture's real 1.40:1 aspect — passing it means
				// the plate renders taller here rather than showing a different crop
				// than the homepage carousel, which covers it into a 1400×720 stage.
				src: "/screenshots/hero-services.webp",
				width: 2974,
				height: 2122,
				alt: "The service catalog listing latency percentiles, error-rate trends and throughput per service",
			},
			facts: [
				{ key: "topology", value: "derived from spans" },
				{ key: "nodes", value: "service · db · cache · external" },
				{ key: "edges", value: "parent → child" },
				{ key: "per.service", value: "p50 · p95 · p99 · error% · req/s" },
				{ key: "colour", value: "16 hues · service identity" },
			],
			title: m.feat_catalog_panel_title,
			lede: m.feat_catalog_panel_lede,
		},
		artifact: {
			id: "service-map",
			title: m.feat_catalog_artifact_title,
			lede: m.feat_catalog_artifact_lede,
			wide: true,
		},
		extraSections: [],
		capTitle: m.feat_catalog_cap_title,
		capabilities: [
			{ op: "edges", title: m.feat_catalog_cap_1_title, body: m.feat_catalog_cap_1_body },
			{ op: "db.system", title: m.feat_catalog_cap_2_title, body: m.feat_catalog_cap_2_body },
			{ op: "1-hop / 2-hop", title: m.feat_catalog_cap_3_title, body: m.feat_catalog_cap_3_body },
			{ op: "service.name", title: m.feat_catalog_cap_4_title, body: m.feat_catalog_cap_4_body },
			{ op: "service.version", title: m.feat_catalog_cap_5_title, body: m.feat_catalog_cap_5_body },
		],
		related: ["distributed-tracing", "kubernetes-monitoring", "metrics-dashboards"],
		relatedUseCases: ["microservices-debugging"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "error-tracking",
		navLabel: m.nav_error_tracking,
		navDesc: m.nav_desc_error_tracking,
		seoTitle: m.feat_errors_seo_title,
		seoDescription: m.feat_errors_seo_desc,
		heroTitle: m.feat_errors_hero_title,
		heroLede: m.feat_errors_hero_lede,
		panel: {
			route: "/errors",
			constant: "ConnectionTimeout · payment-svc",
			plate: {
				src: "/screenshots/surface-errors.webp",
				width: 2560,
				height: 1320,
				alt: "Errors grouped by type with counts, affected services and last-seen times",
			},
			facts: [
				{ key: "groups.by", value: "exception.type + message" },
				{ key: "normalises", value: "id · timestamp · host · port" },
				{ key: "per.issue", value: "first · last · count · services" },
				{ key: "joins.on", value: "trace_id · span_id" },
				{ key: "severity", value: "manual > detector > ai" },
				{ key: "detector", value: "5 min" },
			],
			title: m.feat_errors_panel_title,
			lede: m.feat_errors_panel_lede,
		},
		// The plate is the proof here — an errors list is a static surface, and a
		// live artifact would be animation for its own sake.
		artifact: null,
		extraSections: [],
		capTitle: m.feat_errors_cap_title,
		capabilities: [
			{ op: "fingerprint", title: m.feat_errors_cap_1_title, body: m.feat_errors_cap_1_body },
			{ op: "exception.stacktrace", title: m.feat_errors_cap_2_title, body: m.feat_errors_cap_2_body },
			{ op: "first seen", title: m.feat_errors_cap_3_title, body: m.feat_errors_cap_3_body },
			{ op: "claim", title: m.feat_errors_cap_4_title, body: m.feat_errors_cap_4_body },
			{ op: "set severity", title: m.feat_errors_cap_5_title, body: m.feat_errors_cap_5_body },
		],
		related: ["distributed-tracing", "log-management", "ai-mcp-integration"],
		relatedUseCases: ["ecommerce-observability"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "ai-mcp-integration",
		navLabel: m.nav_ai_mcp,
		navDesc: m.nav_desc_ai_mcp,
		seoTitle: m.feat_mcp_seo_title,
		seoDescription: m.feat_mcp_seo_desc,
		heroTitle: m.feat_mcp_hero_title,
		heroLede: m.feat_mcp_hero_lede,
		panel: {
			route: "/mcp",
			constant: "api.maple.dev/mcp",
			plate: {
				src: "/screenshots/surface-mcp.webp",
				width: 2560,
				height: 1320,
				alt: "The MCP server page showing the endpoint and client setup",
			},
			facts: [
				{ key: "protocol", value: "MCP / HTTP" },
				{ key: "clients", value: "Claude Code · any MCP client" },
				{ key: "default", value: "read-only" },
				{ key: "scope", value: "OrgId" },
				{ key: "reads", value: "traces · logs · metrics · sessions · issues" },
				{ key: "writes", value: "issues · alert rules" },
			],
			title: m.feat_mcp_panel_title,
			lede: m.feat_mcp_panel_lede,
		},
		artifact: {
			id: "mcp-transcript",
			title: m.feat_mcp_artifact_title,
			lede: m.feat_mcp_artifact_lede,
			wide: true,
		},
		extraSections: [],
		capTitle: m.feat_mcp_cap_title,
		capabilities: [
			{ op: "diagnose_service()", title: m.feat_mcp_cap_1_title, body: m.feat_mcp_cap_1_body },
			{ op: "find_slow_traces()", title: m.feat_mcp_cap_2_title, body: m.feat_mcp_cap_2_body },
			{ op: "read_source_file()", title: m.feat_mcp_cap_3_title, body: m.feat_mcp_cap_3_body },
			{ op: "claim_error_issue()", title: m.feat_mcp_cap_4_title, body: m.feat_mcp_cap_4_body },
			{ op: "OrgId filter", title: m.feat_mcp_cap_5_title, body: m.feat_mcp_cap_5_body },
		],
		related: ["error-tracking", "distributed-tracing", "service-catalog"],
		relatedUseCases: ["api-performance"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "kubernetes-monitoring",
		navLabel: m.nav_kubernetes,
		navDesc: m.nav_desc_kubernetes,
		seoTitle: m.page_k8s_title,
		seoDescription: m.page_k8s_desc,
		heroTitle: m.page_k8s_heading,
		heroLede: m.page_k8s_subtitle,
		// No panel: there is no Kubernetes capture in the library, and this page's
		// surface is carried by the console section below — which is the live
		// workloads view, at full fidelity, rather than a placeholder dot-grid.
		panel: null,
		artifact: {
			id: "k8s-heatmap",
			title: m.k8s_title,
			lede: m.k8s_lede,
			wide: true,
		},
		extraSections: ["k8s-console", "k8s-views", "k8s-correlation", "k8s-install"],
		capTitle: m.feat_k8s_cap_title,
		capabilities: [
			{ op: "helm install", title: m.page_k8s_helm, body: m.page_k8s_helm_desc },
			{ op: "k8s.pod.name", title: m.page_k8s_correlation, body: m.page_k8s_correlation_desc },
			{ op: "kube-state", title: m.page_k8s_kube_state, body: m.page_k8s_kube_state_desc },
			{ op: "/infra/kubernetes", title: m.page_k8s_views, body: m.page_k8s_views_desc },
			{ op: "OTel Operator", title: m.page_k8s_operator, body: m.page_k8s_operator_desc },
			{ op: "one endpoint", title: m.page_k8s_multi, body: m.page_k8s_multi_desc },
		],
		related: ["service-catalog", "metrics-dashboards", "distributed-tracing"],
		relatedUseCases: ["microservices-debugging"],
		locales: ["en", "ja", "ko"],
	},
]

export const featureSlugs = features.map((feature) => feature.slug)

export const featureBySlug = (slug: string) => features.find((feature) => feature.slug === slug)
