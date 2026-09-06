/**
 * `/pricing.md` — the agent-readable twin of `/pricing`.
 *
 * Reads the same `getOffer()` the page does, so the two can't disagree. The
 * meter becomes a table, the FAQ becomes `###` sections, and the enterprise
 * rail keeps its "From $2,000" anchor because that number is what makes $39
 * read as nothing.
 */
import type { APIRoute } from "astro"
import { blocks, docHeader, markdown, table } from "../lib/page-markdown"
import {
	getOffer,
	money,
	platformFeatures,
	rateBlock,
	rateLabel,
	volume,
	type Allotment,
} from "../lib/pricing-offer"
import * as m from "../paraglide/messages.js"
import { pricingFaq } from "../lib/pricing-faq"

/** "GB", "session", or "1,000 events" — the block the rate is quoted per. */
const unitLabel = (a: Allotment) =>
	a.unit === "gb" ? "GB" : a.unit === "sessions" ? "session" : `${rateBlock(a)} events`

export const GET: APIRoute = async () => {
	const offer = await getOffer()

	const meter = table(
		["Signal", "Included every month", "Then"],
		offer.allotments.map((a) => [
			a.label,
			volume(a, a.included),
			a.unlimited
				? m.pricing_free_beta()
				: a.rate === undefined
					? "—"
					: `${rateLabel(a.rate)} / ${unitLabel(a)}`,
		]),
	)

	const trial =
		offer.hasTrial && offer.trialDuration
			? m.pricing_trial_reassure({ duration: String(offer.trialDuration) })
			: undefined

	const faq = await pricingFaq()

	const gb = offer.allotments.find((a) => a.unit === "gb")
	const lede = m.pricing_hero_lede({
		price: money(offer.price),
		included: String(gb?.included ?? 0),
		rate: rateLabel(gb?.rate ?? 0),
	})
	const claims = [m.pricing_no_seat(), m.pricing_no_host(), m.pricing_no_series()]
	const RETENTION_DAYS = 30

	const paths = table(
		["Option", "Price", "What it is", "Best when"],
		[
			[
				m.pricing_path_local_name(),
				m.pricing_path_local_price(),
				m.pricing_path_local_body(),
				m.pricing_path_local_when(),
			],
			[
				m.pricing_path_selfhost_name(),
				m.pricing_path_selfhost_price(),
				m.pricing_path_selfhost_body(),
				m.pricing_path_selfhost_when(),
			],
			[
				m.pricing_path_cloud_name(),
				m.pricing_path_cloud_price({ price: money(offer.price) }),
				m.pricing_path_cloud_body({
					retention: String(RETENTION_DAYS),
					trial: String(offer.trialDuration ?? 14),
				}),
				m.pricing_path_cloud_when(),
			],
			[
				m.pricing_path_enterprise_name(),
				m.pricing_enterprise_price(),
				m.pricing_path_enterprise_body(),
				m.pricing_path_enterprise_when(),
			],
		],
	)

	return markdown(
		blocks(
			docHeader("Maple Pricing", m.pricing_hero_title()),
			lede,
			claims.map((c) => `- ${c}`).join("\n"),
			m.pricing_rates_retention({ days: String(RETENTION_DAYS) }),

			`## ${offer.name} — ${money(offer.price)}${offer.interval ?? ""}`,
			m.pricing_everything_included(),
			meter,
			`No per-host, per-seat or per-query fees: $0 ${m.pricing_zero_host()}, $0 ${m.pricing_zero_seat()}, $0 ${m.pricing_zero_query()}.`,
			`Included: ${platformFeatures().join(" · ")}.`,
			trial,
			"Start at [app.maple.dev](https://app.maple.dev).",

			`## ${m.pricing_enterprise()} — ${m.pricing_enterprise_price()}`,
			m.pricing_enterprise_rail(),
			"Talk to a founder: [cal.com/david-granzin](https://cal.com/david-granzin/30min?overlayCalendar=true).",

			`## ${m.stack_heading()}`,
			m.stack_lede(),
			blocks(
				`- **${m.stack_apm_title()}** — Effect, Node.js, Next.js, Python, Go, Rust, Java, C#, Kotlin, Laravel, and any OpenTelemetry SDK. ${m.stack_apm_body()}`,
				`- **${m.stack_frontend_title()}** — ${m.stack_chip_browser()}, ${m.stack_chip_ios()}. ${m.stack_frontend_body()}`,
				`- **${m.stack_infra_title()}** — ${m.stack_chip_collector()}, Kubernetes, Docker, Prometheus, Cloudflare. ${m.stack_infra_body()}`,
				`- **${m.stack_cloud_title()}** — Cloudflare, PlanetScale, GitHub, WarpStream, Hazel. ${m.stack_cloud_body()}`,
				`- **${m.stack_alerts_title()}** — Slack, PagerDuty, Discord, Telegram, ${m.stack_chip_email()}, ${m.stack_chip_webhooks()}, Hazel.`,
				`- **${m.stack_agents_title()}** — ${m.stack_chip_claude_code()}, ${m.stack_chip_cursor()}, ${m.stack_chip_any_mcp()}. ${m.stack_agents_body()}`,
			),
			`${m.stack_otel_title()}: ${m.stack_otel_body()}`,

			`## ${m.pricing_paths_heading()}`,
			m.pricing_paths_lede(),
			paths,

			`## ${m.pricing_calc_heading()}`,
			m.pricing_calc_sub(),
			"Formula for the Maple column: plan price + Σ per signal max(0, volume − included) × rate. Try it at [maple.dev/pricing#calculator](https://maple.dev/pricing#calculator).",

			`## ${m.faq_heading()}`,
			...faq.map(({ question, answer }) => `### ${question}\n\n${answer}`),
		),
	)
}
