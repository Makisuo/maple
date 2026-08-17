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
import { getOffer, money, platformFeatures, rateBlock, rateLabel, type Allotment } from "../lib/pricing-offer"
import * as m from "../paraglide/messages.js"

/** "GB", "session", or "1,000 events" — the block the rate is quoted per. */
const unitLabel = (a: Allotment) =>
	a.unit === "gb" ? "GB" : a.unit === "sessions" ? "session" : `${rateBlock(a)} events`

export const GET: APIRoute = async () => {
	const offer = await getOffer()

	const meter = table(
		["Signal", "Included every month", "Then"],
		offer.allotments.map((a) => [
			a.label,
			a.unit === "gb" ? `${a.included} GB` : a.included.toLocaleString("en-US"),
			a.rate === undefined ? "—" : `${rateLabel(a.rate)} / ${unitLabel(a)}`,
		]),
	)

	const trial =
		offer.hasTrial && offer.trialDuration
			? m.pricing_trial_reassure({ duration: String(offer.trialDuration) })
			: undefined

	const faq = [
		[m.faq_ingestion_q(), m.faq_ingestion_a()],
		[m.faq_limits_q(), m.faq_limits_a()],
		[m.faq_retention_q(), m.faq_retention_a()],
		[m.faq_otel_q(), m.faq_otel_a()],
		[m.faq_selfhost_q(), m.faq_selfhost_a()],
		[m.faq_trial_q(), m.faq_trial_a()],
	]

	return markdown(
		blocks(
			docHeader("Maple Pricing", m.page_pricing_subtitle()),

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

			`## ${m.faq_heading()}`,
			...faq.map(([question, answer]) => `### ${question}\n\n${answer}`),
		),
	)
}
