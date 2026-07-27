/**
 * The use-case registry. One entry per `/use-cases/<slug>` route.
 *
 * Read `page-registry.ts` first — messages are stored uncalled, and this file
 * must not import `.astro` or `astro:i18n`.
 *
 * Each entry drives one `ScrollStory`. The device is the homepage's, but the
 * argument is not: what the frame head holds is a different kind of object on
 * every page — an SLO, an order id, a release — and the head also carries a
 * clock, because a use case's claim is partly about how little time it took.
 *
 * Every story here runs at least two real plates, so none falls back to the
 * inline layout (see `storyIsPinnable`).
 */
import * as m from "../paraglide/messages"
import type { UseCase } from "./page-registry"

export const useCases: UseCase[] = [
	{
		slug: "api-performance",
		navLabel: m.nav_api_performance,
		navDesc: m.nav_desc_api_performance,
		seoTitle: m.uc_api_seo_title,
		seoDescription: m.uc_api_seo_desc,
		heroTitle: m.uc_api_hero_title,
		heroLede: m.uc_api_hero_lede,
		signal: "checkout p99 380 ms · threshold 200 ms",
		constant: "checkout p99 ≤ 200 ms",
		constantLabel: "slo",
		storyTitle: m.uc_api_story_title,
		storyLede: m.uc_api_story_lede,
		// surface-alerts and hero-dashboard are both ~1.94:1, and the authored
		// third plate matches, so this story is aspect-clean.
		storyAspect: "1280 / 660",
		steps: [
			{
				surface: "alert",
				route: "/alerts",
				elapsed: "T+0:00",
				title: m.uc_api_step_1_title,
				body: m.uc_api_step_1_body,
				plate: {
					src: "/screenshots/surface-alerts.webp",
					width: 2560,
					height: 1320,
					alt: "Alert rules listed with severity, signal type and current state",
				},
			},
			{
				surface: "dashboard",
				route: "/",
				elapsed: "T+0:40",
				title: m.uc_api_step_2_title,
				body: m.uc_api_step_2_body,
				plate: {
					src: "/screenshots/hero-dashboard.webp",
					width: 3600,
					height: 1850,
					alt: "The overview dashboard with request volume, error rate, latency and log volume charts",
				},
			},
			{
				surface: "releases",
				route: "/services/order-service",
				elapsed: "T+3:15",
				title: m.uc_api_step_3_title,
				body: m.uc_api_step_3_body,
				plate: {
					src: "/screenshots/story-api-releases.webp",
					width: 1280,
					height: 660,
					alt: "Two releases of one endpoint compared on p50, p95, p99 and error rate",
					caption:
						"Commit comparison on order-service: abc123 against def456, p50/p95/p99 and error % per row, with the p99 delta called out.",
				},
			},
		],
		outcomeLine: m.uc_api_outcome_line,
		outcomeMetrics: [
			{ value: "9 min", label: m.uc_api_metric_1_label },
			{ value: "120 → 380 ms", label: m.uc_api_metric_2_label },
			{ value: "3 → 50", label: m.uc_api_metric_3_label },
		],
		capTitle: m.uc_api_cap_title,
		capabilities: [
			{ op: "p99 > 200ms", title: m.uc_api_cap_1_title, body: m.uc_api_cap_1_body },
			{ op: "service.version", title: m.uc_api_cap_2_title, body: m.uc_api_cap_2_body },
			{ op: "select range", title: m.uc_api_cap_3_title, body: m.uc_api_cap_3_body },
		],
		related: ["microservices-debugging", "ecommerce-observability"],
		relatedFeatures: ["metrics-dashboards", "ai-mcp-integration"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "ecommerce-observability",
		navLabel: m.nav_ecommerce,
		navDesc: m.nav_desc_ecommerce,
		seoTitle: m.uc_ecom_seo_title,
		seoDescription: m.uc_ecom_seo_desc,
		heroTitle: m.uc_ecom_hero_title,
		heroLede: m.uc_ecom_hero_lede,
		signal: "POST /checkout error rate 8.4% · threshold 1%",
		constant: "order_8421",
		constantLabel: "order",
		storyTitle: m.uc_ecom_story_title,
		storyLede: m.uc_ecom_story_lede,
		storyAspect: "992 / 600",
		steps: [
			{
				surface: "alert",
				route: "/alerts",
				elapsed: "T+0:00",
				title: m.uc_ecom_step_1_title,
				body: m.uc_ecom_step_1_body,
				plate: {
					src: "/screenshots/flow-01-alert.webp",
					width: 2976,
					height: 1800,
					alt: "An alert rule with its threshold, evaluation window and firing history",
				},
			},
			{
				surface: "trace",
				route: "/traces",
				elapsed: "T+0:25",
				title: m.uc_ecom_step_2_title,
				body: m.uc_ecom_step_2_body,
				plate: {
					src: "/screenshots/strip-trace.webp",
					width: 2976,
					height: 1800,
					alt: "An 18-span API trace waterfall with nested application and SQL operations",
				},
			},
			{
				surface: "logs",
				route: "/errors",
				elapsed: "T+2:10",
				title: m.uc_ecom_step_3_title,
				body: m.uc_ecom_step_3_body,
				plate: {
					src: "/screenshots/story-ecommerce-error.webp",
					width: 992,
					height: 600,
					alt: "The StripeTimeout issue with its affected-order count and the sessions that produced them",
					caption:
						"The StripeTimeout error issue: affected order count, retry-exhaustion log lines carrying the same trace id, and the sessions behind them.",
				},
			},
		],
		outcomeLine: m.uc_ecom_outcome_line,
		outcomeMetrics: [
			{ value: "2 min", label: m.uc_ecom_metric_1_label },
			{ value: "3", label: m.uc_ecom_metric_2_label },
			{ value: "1.75 s", label: m.uc_ecom_metric_3_label },
		],
		capTitle: m.uc_ecom_cap_title,
		capabilities: [
			{ op: "order.id", title: m.uc_ecom_cap_1_title, body: m.uc_ecom_cap_1_body },
			{ op: "SpanKind.CLIENT", title: m.uc_ecom_cap_2_title, body: m.uc_ecom_cap_2_body },
			{ op: "trace_id", title: m.uc_ecom_cap_3_title, body: m.uc_ecom_cap_3_body },
		],
		related: ["microservices-debugging", "api-performance"],
		relatedFeatures: ["error-tracking", "browser-sessions"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "microservices-debugging",
		navLabel: m.nav_microservices,
		navDesc: m.nav_desc_microservices,
		seoTitle: m.uc_micro_seo_title,
		seoDescription: m.uc_micro_seo_desc,
		heroTitle: m.uc_micro_hero_title,
		heroLede: m.uc_micro_hero_lede,
		signal: "api-gateway p95 1.9 s · was 0.9 s, no deploy",
		constant: "payment-svc@1.4.2",
		constantLabel: "deploy",
		storyTitle: m.uc_micro_story_title,
		storyLede: m.uc_micro_story_lede,
		// surface-map is 1.94:1 against flow-02/03's 1.65:1. Running the story at
		// 992/600 letterboxes one plate; running it at 1280/660 would letterbox
		// two. `.story-frame__stage` insets with object-fit: contain either way.
		storyAspect: "992 / 600",
		steps: [
			{
				surface: "map",
				route: "/service-map",
				elapsed: "T+0:00",
				title: m.uc_micro_step_1_title,
				body: m.uc_micro_step_1_body,
				plate: {
					src: "/screenshots/surface-map.webp",
					width: 2560,
					height: 1320,
					alt: "A service neighbourhood showing API, database and cache dependencies with live request flow",
				},
			},
			{
				surface: "trace",
				route: "/traces",
				elapsed: "T+1:10",
				title: m.uc_micro_step_2_title,
				body: m.uc_micro_step_2_body,
				plate: {
					src: "/screenshots/flow-02-trace.webp",
					width: 2976,
					height: 1800,
					alt: "A span selected in the waterfall with its full attribute set open alongside",
				},
			},
			{
				surface: "logs",
				route: "/logs",
				elapsed: "T+2:40",
				title: m.uc_micro_step_3_title,
				body: m.uc_micro_step_3_body,
				plate: {
					src: "/screenshots/flow-03-logs.webp",
					width: 2976,
					height: 1800,
					alt: "A log detail with linked trace and span IDs, correlated events and full resource attributes",
				},
			},
		],
		outcomeLine: m.uc_micro_outcome_line,
		outcomeMetrics: [
			{ value: "2", label: m.uc_micro_metric_1_label },
			{ value: "12 → 210 ms", label: m.uc_micro_metric_2_label },
			{ value: "98%", label: m.uc_micro_metric_3_label },
		],
		capTitle: m.uc_micro_cap_title,
		capabilities: [
			{ op: "edge latency", title: m.uc_micro_cap_1_title, body: m.uc_micro_cap_1_body },
			{ op: "db.statement", title: m.uc_micro_cap_2_title, body: m.uc_micro_cap_2_body },
			{ op: "service.version", title: m.uc_micro_cap_3_title, body: m.uc_micro_cap_3_body },
		],
		related: ["api-performance", "ecommerce-observability"],
		relatedFeatures: ["service-catalog", "distributed-tracing"],
		locales: ["en", "ja", "ko"],
	},
]

export const useCaseSlugs = useCases.map((useCase) => useCase.slug)

export const useCaseBySlug = (slug: string) => useCases.find((useCase) => useCase.slug === slug)
