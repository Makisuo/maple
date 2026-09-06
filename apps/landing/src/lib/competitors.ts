/**
 * The comparison registry. One entry per `/compare/<slug>` route, in all
 * three locales, rendered by `components/compare/ComparePage.astro`.
 *
 * Same rules as `page-registry.ts`: copy is stored as uncalled Paraglide
 * thunks and resolved by the template at render time, and this module must
 * not import `.astro` or `astro:i18n`.
 *
 * The shape is difference-first. A comparison is not a feature matrix with
 * two columns of checkmarks — those pages had eleven ✓/✓ rows out of sixteen
 * and buried the five that mattered. Each entry instead carries:
 *
 * - `differences`: rows where the two tools actually diverge, each cell a
 *   sentence and each row tagged with who has the `edge`, so the honest
 *   "where the other tool is ahead" group is data, not a separate section
 *   someone forgets to write;
 * - `parity`: everything both do, collapsed to one chip line;
 * - `sources`: the vendor pages the competitor cells were checked against,
 *   with the month they were checked. Rows reference them by index.
 *
 * Every vendor-specific literal (prices, product names, URLs) is literal and
 * untranslated; only prose is a thunk.
 */
import * as m from "../paraglide/messages.js"
import type { BrandMarkId } from "./brand-marks"
import type { Vendor } from "./vendor-pricing"

type Locale = "en" | "ja" | "ko"

/** A Paraglide message, uncalled. */
type Msg = () => string

export type Edge = "maple" | "competitor" | "even"

export interface Source {
	label: string
	url: string
	/** `YYYY-MM` — the month the claim was last checked against the page. */
	checked: string
}

export interface DifferenceRow {
	/** Stable anchor id: `#row-<id>`. Shared vocabulary across vendors. */
	id: string
	topic: Msg
	maple: Msg
	competitor: Msg
	edge: Edge
	/** Index into `Competitor.sources`. */
	source?: number
	/** A roadmap entry that closes this gap, when one exists. */
	roadmap?: string
}

export interface MigrationStep {
	title: Msg
	body: Msg
}

export interface Faq {
	question: Msg
	answer: Msg
}

export interface Competitor {
	slug: string
	/** Literal vendor name; product names are never translated. */
	name: string
	/** Which price model `lib/vendor-pricing.ts` runs for the receipts. */
	vendor: Vendor
	/** The vendor's mark in `lib/brand-marks.ts`, for the hero pairing and hub cards. */
	mark: BrandMarkId
	/** The vendor's site, shown under the mark. Literal. */
	site: string
	navLabel: Msg
	navDesc: Msg
	seoTitle: Msg
	seoDescription: Msg
	heroTitle: Msg
	heroLede: Msg
	differences: DifferenceRow[]
	parity: Msg[]
	migration: MigrationStep[]
	/**
	 * The one code block on the page: the Collector exporter change, as the
	 * operator would type it. Literal YAML.
	 */
	migrationDiff: string
	faqs: Faq[]
	sources: Source[]
	related: string[]
	locales: readonly Locale[]
}

const CHECKED = "2026-08"

const MAPLE_EXPORTER = `  otlphttp/maple:
    endpoint: https://ingest.maple.dev
    headers:
      x-maple-ingest-key: \${env:MAPLE_INGEST_KEY}`

const collectorDiff = (existingKey: string, existingBlock: string) => `exporters:
${existingBlock}
${MAPLE_EXPORTER}

service:
  pipelines:
    traces:
      exporters: [${existingKey}, otlphttp/maple]
    logs:
      exporters: [${existingKey}, otlphttp/maple]
    metrics:
      exporters: [${existingKey}, otlphttp/maple]`

const CORE_PARITY: Msg[] = [
	m.cmp_parity_tracing,
	m.cmp_parity_logs,
	m.cmp_parity_metrics,
	m.cmp_parity_alerting,
	m.cmp_parity_errors,
	m.cmp_parity_k8s,
	m.cmp_parity_api,
	m.cmp_parity_mcp,
]

export const competitors: Competitor[] = [
	{
		slug: "datadog",
		name: "Datadog",
		vendor: "datadog",
		mark: "datadog",
		site: "datadoghq.com",
		navLabel: m.nav_vs_datadog,
		navDesc: m.nav_desc_vs_datadog,
		seoTitle: m.cmp_dd_seo_title,
		seoDescription: m.cmp_dd_seo_desc,
		heroTitle: m.cmp_dd_hero_title,
		heroLede: m.cmp_dd_hero_lede,
		differences: [
			{ id: "pricing", topic: m.cmp_topic_pricing, maple: m.cmp_dd_pricing_maple, competitor: m.cmp_dd_pricing_them, edge: "maple", source: 0 },
			{ id: "hosts", topic: m.cmp_topic_hosts, maple: m.cmp_dd_hosts_maple, competitor: m.cmp_dd_hosts_them, edge: "maple", source: 0 },
			{ id: "agents", topic: m.cmp_topic_agents, maple: m.cmp_dd_agents_maple, competitor: m.cmp_dd_agents_them, edge: "maple", source: 1 },
			{ id: "source", topic: m.cmp_topic_source, maple: m.cmp_dd_source_maple, competitor: m.cmp_dd_source_them, edge: "maple" },
			{ id: "selfhost", topic: m.cmp_topic_selfhost, maple: m.cmp_dd_selfhost_maple, competitor: m.cmp_dd_selfhost_them, edge: "maple" },
			{ id: "retention", topic: m.cmp_topic_retention, maple: m.cmp_dd_retention_maple, competitor: m.cmp_dd_retention_them, edge: "maple", source: 2 },
			{ id: "setup", topic: m.cmp_topic_setup, maple: m.cmp_dd_setup_maple, competitor: m.cmp_dd_setup_them, edge: "maple" },
			{ id: "ai", topic: m.cmp_topic_ai, maple: m.cmp_dd_ai_maple, competitor: m.cmp_dd_ai_them, edge: "even", source: 3 },
			{ id: "synthetics", topic: m.cmp_topic_synthetics, maple: m.cmp_dd_synthetics_maple, competitor: m.cmp_dd_synthetics_them, edge: "competitor", source: 0 },
			{ id: "products", topic: m.cmp_topic_products, maple: m.cmp_dd_products_maple, competitor: m.cmp_dd_products_them, edge: "competitor", source: 0 },
			{ id: "integrations", topic: m.cmp_topic_integrations, maple: m.cmp_dd_integrations_maple, competitor: m.cmp_dd_integrations_them, edge: "competitor", source: 4 },
			{ id: "rum", topic: m.cmp_topic_rum, maple: m.cmp_dd_rum_maple, competitor: m.cmp_dd_rum_them, edge: "competitor", source: 0 },
			{ id: "compliance", topic: m.cmp_topic_compliance, maple: m.cmp_dd_compliance_maple, competitor: m.cmp_dd_compliance_them, edge: "competitor", source: 5 },
		],
		parity: [...CORE_PARITY, m.cmp_parity_replay],
		migration: [
			{ title: m.cmp_dd_mig_1_title, body: m.cmp_dd_mig_1_body },
			{ title: m.cmp_dd_mig_2_title, body: m.cmp_dd_mig_2_body },
			{ title: m.cmp_dd_mig_3_title, body: m.cmp_dd_mig_3_body },
		],
		migrationDiff: collectorDiff(
			"datadog",
			`  datadog:
    api:
      key: \${env:DD_API_KEY}`,
		),
		faqs: [
			{ question: m.cmp_dd_faq_1_q, answer: m.cmp_dd_faq_1_a },
			{ question: m.cmp_dd_faq_2_q, answer: m.cmp_dd_faq_2_a },
			{ question: m.cmp_dd_faq_3_q, answer: m.cmp_dd_faq_3_a },
			{ question: m.cmp_dd_faq_4_q, answer: m.cmp_dd_faq_4_a },
			{ question: m.cmp_dd_faq_5_q, answer: m.cmp_dd_faq_5_a },
		],
		sources: [
			{ label: "Datadog pricing", url: "https://www.datadoghq.com/pricing/", checked: CHECKED },
			{ label: "Datadog: OpenTelemetry in Datadog", url: "https://docs.datadoghq.com/opentelemetry/", checked: CHECKED },
			{ label: "Datadog: Log Management pricing", url: "https://www.datadoghq.com/pricing/?product=log-management", checked: CHECKED },
			{ label: "Datadog: Bits AI and MCP Server", url: "https://docs.datadoghq.com/bits_ai/mcp_server/", checked: CHECKED },
			{ label: "Datadog integrations", url: "https://docs.datadoghq.com/integrations/", checked: CHECKED },
			{ label: "Datadog Trust Center", url: "https://www.datadoghq.com/security/", checked: CHECKED },
		],
		related: ["new-relic", "grafana", "dash0"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "grafana",
		name: "Grafana",
		vendor: "grafana",
		mark: "grafana",
		site: "grafana.com",
		navLabel: m.nav_vs_grafana,
		navDesc: m.nav_desc_vs_grafana,
		seoTitle: m.cmp_gf_seo_title,
		seoDescription: m.cmp_gf_seo_desc,
		heroTitle: m.cmp_gf_hero_title,
		heroLede: m.cmp_gf_hero_lede,
		differences: [
			{ id: "backends", topic: m.cmp_topic_backends, maple: m.cmp_gf_backends_maple, competitor: m.cmp_gf_backends_them, edge: "maple" },
			{ id: "query", topic: m.cmp_topic_query, maple: m.cmp_gf_query_maple, competitor: m.cmp_gf_query_them, edge: "maple" },
			{ id: "pricing", topic: m.cmp_topic_pricing, maple: m.cmp_gf_pricing_maple, competitor: m.cmp_gf_pricing_them, edge: "maple", source: 0 },
			{ id: "seats", topic: m.cmp_topic_seats, maple: m.cmp_gf_seats_maple, competitor: m.cmp_gf_seats_them, edge: "maple", source: 0 },
			{ id: "setup", topic: m.cmp_topic_setup, maple: m.cmp_gf_setup_maple, competitor: m.cmp_gf_setup_them, edge: "maple" },
			{ id: "source", topic: m.cmp_topic_source, maple: m.cmp_gf_source_maple, competitor: m.cmp_gf_source_them, edge: "even", source: 1 },
			{ id: "selfhost", topic: m.cmp_topic_selfhost, maple: m.cmp_gf_selfhost_maple, competitor: m.cmp_gf_selfhost_them, edge: "even" },
			{ id: "otel", topic: m.cmp_topic_otel, maple: m.cmp_gf_otel_maple, competitor: m.cmp_gf_otel_them, edge: "even", source: 2 },
			{ id: "plugins", topic: m.cmp_topic_plugins, maple: m.cmp_gf_plugins_maple, competitor: m.cmp_gf_plugins_them, edge: "competitor", source: 3 },
			{ id: "promql", topic: m.cmp_topic_promql, maple: m.cmp_gf_promql_maple, competitor: m.cmp_gf_promql_them, edge: "competitor" },
			{ id: "datasources", topic: m.cmp_topic_datasources, maple: m.cmp_gf_datasources_maple, competitor: m.cmp_gf_datasources_them, edge: "competitor", source: 3 },
			{ id: "oncall", topic: m.cmp_topic_oncall, maple: m.cmp_gf_oncall_maple, competitor: m.cmp_gf_oncall_them, edge: "competitor", source: 4 },
		],
		parity: CORE_PARITY,
		migration: [
			{ title: m.cmp_gf_mig_1_title, body: m.cmp_gf_mig_1_body },
			{ title: m.cmp_gf_mig_2_title, body: m.cmp_gf_mig_2_body },
			{ title: m.cmp_gf_mig_3_title, body: m.cmp_gf_mig_3_body },
		],
		migrationDiff: collectorDiff(
			"otlp/tempo",
			`  otlp/tempo:
    endpoint: tempo:4317`,
		),
		faqs: [
			{ question: m.cmp_gf_faq_1_q, answer: m.cmp_gf_faq_1_a },
			{ question: m.cmp_gf_faq_2_q, answer: m.cmp_gf_faq_2_a },
			{ question: m.cmp_gf_faq_3_q, answer: m.cmp_gf_faq_3_a },
			{ question: m.cmp_gf_faq_4_q, answer: m.cmp_gf_faq_4_a },
			{ question: m.cmp_gf_faq_5_q, answer: m.cmp_gf_faq_5_a },
		],
		sources: [
			{ label: "Grafana Cloud pricing", url: "https://grafana.com/pricing/", checked: CHECKED },
			{ label: "Grafana licensing (AGPL-3.0)", url: "https://grafana.com/licensing/", checked: CHECKED },
			{ label: "Grafana Alloy", url: "https://grafana.com/docs/alloy/latest/", checked: CHECKED },
			{ label: "Grafana plugins catalog", url: "https://grafana.com/grafana/plugins/", checked: CHECKED },
			{ label: "Grafana IRM", url: "https://grafana.com/products/cloud/irm/", checked: CHECKED },
		],
		related: ["datadog", "dash0", "new-relic"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "new-relic",
		name: "New Relic",
		vendor: "new-relic",
		mark: "newrelic",
		site: "newrelic.com",
		navLabel: m.nav_vs_new_relic,
		navDesc: m.nav_desc_vs_new_relic,
		seoTitle: m.cmp_nr_seo_title,
		seoDescription: m.cmp_nr_seo_desc,
		heroTitle: m.cmp_nr_hero_title,
		heroLede: m.cmp_nr_hero_lede,
		differences: [
			{ id: "seats", topic: m.cmp_topic_seats, maple: m.cmp_nr_seats_maple, competitor: m.cmp_nr_seats_them, edge: "maple", source: 0 },
			{ id: "pricing", topic: m.cmp_topic_pricing, maple: m.cmp_nr_pricing_maple, competitor: m.cmp_nr_pricing_them, edge: "maple", source: 0 },
			{ id: "agents", topic: m.cmp_topic_agents, maple: m.cmp_nr_agents_maple, competitor: m.cmp_nr_agents_them, edge: "maple", source: 1 },
			{ id: "source", topic: m.cmp_topic_source, maple: m.cmp_nr_source_maple, competitor: m.cmp_nr_source_them, edge: "maple" },
			{ id: "selfhost", topic: m.cmp_topic_selfhost, maple: m.cmp_nr_selfhost_maple, competitor: m.cmp_nr_selfhost_them, edge: "maple" },
			{ id: "retention", topic: m.cmp_topic_retention, maple: m.cmp_nr_retention_maple, competitor: m.cmp_nr_retention_them, edge: "maple", source: 2 },
			{ id: "query", topic: m.cmp_topic_query, maple: m.cmp_nr_query_maple, competitor: m.cmp_nr_query_them, edge: "even" },
			{ id: "ai", topic: m.cmp_topic_ai, maple: m.cmp_nr_ai_maple, competitor: m.cmp_nr_ai_them, edge: "even", source: 3 },
			{ id: "synthetics", topic: m.cmp_topic_synthetics, maple: m.cmp_nr_synthetics_maple, competitor: m.cmp_nr_synthetics_them, edge: "competitor", source: 0 },
			{ id: "rum", topic: m.cmp_topic_rum, maple: m.cmp_nr_rum_maple, competitor: m.cmp_nr_rum_them, edge: "competitor", source: 0 },
			{ id: "integrations", topic: m.cmp_topic_integrations, maple: m.cmp_nr_integrations_maple, competitor: m.cmp_nr_integrations_them, edge: "competitor", source: 4 },
			{ id: "security", topic: m.cmp_topic_security, maple: m.cmp_nr_security_maple, competitor: m.cmp_nr_security_them, edge: "competitor", source: 0 },
		],
		parity: [...CORE_PARITY, m.cmp_parity_replay],
		migration: [
			{ title: m.cmp_nr_mig_1_title, body: m.cmp_nr_mig_1_body },
			{ title: m.cmp_nr_mig_2_title, body: m.cmp_nr_mig_2_body },
			{ title: m.cmp_nr_mig_3_title, body: m.cmp_nr_mig_3_body },
		],
		migrationDiff: collectorDiff(
			"otlp/newrelic",
			`  otlp/newrelic:
    endpoint: https://otlp.nr-data.net:4317
    headers:
      api-key: \${env:NEW_RELIC_LICENSE_KEY}`,
		),
		faqs: [
			{ question: m.cmp_nr_faq_1_q, answer: m.cmp_nr_faq_1_a },
			{ question: m.cmp_nr_faq_2_q, answer: m.cmp_nr_faq_2_a },
			{ question: m.cmp_nr_faq_3_q, answer: m.cmp_nr_faq_3_a },
			{ question: m.cmp_nr_faq_4_q, answer: m.cmp_nr_faq_4_a },
			{ question: m.cmp_nr_faq_5_q, answer: m.cmp_nr_faq_5_a },
		],
		sources: [
			{ label: "New Relic pricing", url: "https://newrelic.com/pricing", checked: CHECKED },
			{ label: "New Relic: OpenTelemetry", url: "https://docs.newrelic.com/docs/opentelemetry/", checked: CHECKED },
			{ label: "New Relic: data retention", url: "https://docs.newrelic.com/docs/data-apis/manage-data/manage-data-retention/", checked: CHECKED },
			{ label: "New Relic AI", url: "https://newrelic.com/platform/new-relic-ai", checked: CHECKED },
			{ label: "New Relic instant observability", url: "https://newrelic.com/instant-observability", checked: CHECKED },
		],
		related: ["datadog", "grafana", "dash0"],
		locales: ["en", "ja", "ko"],
	},

	{
		slug: "dash0",
		name: "Dash0",
		vendor: "dash0",
		mark: "dash0",
		site: "dash0.com",
		navLabel: m.nav_vs_dash0,
		navDesc: m.nav_desc_vs_dash0,
		seoTitle: m.cmp_d0_seo_title,
		seoDescription: m.cmp_d0_seo_desc,
		heroTitle: m.cmp_d0_hero_title,
		heroLede: m.cmp_d0_hero_lede,
		differences: [
			{ id: "source", topic: m.cmp_topic_source, maple: m.cmp_d0_source_maple, competitor: m.cmp_d0_source_them, edge: "maple", source: 1 },
			{ id: "selfhost", topic: m.cmp_topic_selfhost, maple: m.cmp_d0_selfhost_maple, competitor: m.cmp_d0_selfhost_them, edge: "maple" },
			{ id: "retention", topic: m.cmp_topic_retention, maple: m.cmp_d0_retention_maple, competitor: m.cmp_d0_retention_them, edge: "maple", source: 0 },
			{ id: "pricing", topic: m.cmp_topic_pricing, maple: m.cmp_d0_pricing_maple, competitor: m.cmp_d0_pricing_them, edge: "even", source: 0 },
			{ id: "ai", topic: m.cmp_topic_ai, maple: m.cmp_d0_ai_maple, competitor: m.cmp_d0_ai_them, edge: "even" },
			{ id: "promql", topic: m.cmp_topic_promql, maple: m.cmp_d0_promql_maple, competitor: m.cmp_d0_promql_them, edge: "competitor", source: 2 },
			{ id: "k8s-tooling", topic: m.cmp_topic_k8s_tooling, maple: m.cmp_d0_k8s_tooling_maple, competitor: m.cmp_d0_k8s_tooling_them, edge: "competitor", source: 1 },
		],
		parity: [...CORE_PARITY, m.cmp_parity_otel],
		migration: [
			{ title: m.cmp_d0_mig_1_title, body: m.cmp_d0_mig_1_body },
			{ title: m.cmp_d0_mig_2_title, body: m.cmp_d0_mig_2_body },
			{ title: m.cmp_d0_mig_3_title, body: m.cmp_d0_mig_3_body },
		],
		migrationDiff: collectorDiff(
			"otlp/dash0",
			`  otlp/dash0:
    endpoint: ingress.eu-west-1.aws.dash0.com:4317
    headers:
      Authorization: Bearer \${env:DASH0_AUTH_TOKEN}`,
		),
		faqs: [
			{ question: m.cmp_d0_faq_1_q, answer: m.cmp_d0_faq_1_a },
			{ question: m.cmp_d0_faq_2_q, answer: m.cmp_d0_faq_2_a },
			{ question: m.cmp_d0_faq_3_q, answer: m.cmp_d0_faq_3_a },
			{ question: m.cmp_d0_faq_4_q, answer: m.cmp_d0_faq_4_a },
			{ question: m.cmp_d0_faq_5_q, answer: m.cmp_d0_faq_5_a },
		],
		sources: [
			{ label: "Dash0 pricing", url: "https://www.dash0.com/pricing", checked: CHECKED },
			{ label: "Dash0 on GitHub", url: "https://github.com/dash0hq", checked: CHECKED },
			{ label: "Dash0 documentation", url: "https://www.dash0.com/documentation", checked: CHECKED },
		],
		related: ["grafana", "datadog", "new-relic"],
		locales: ["en", "ja", "ko"],
	},
]

export const competitorSlugs = competitors.map((competitor) => competitor.slug)

export const competitorBySlug = (slug: string) => competitors.find((competitor) => competitor.slug === slug)

const localePath = (locale: string, path: string) => (locale === "en" ? path : `/${locale}${path}`)

export const comparePath = (locale: string, slug?: string) =>
	localePath(locale, slug ? `/compare/${slug}` : "/compare")
