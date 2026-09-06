/**
 * `/compare/<slug>.md` — the comparison registry, serialized.
 *
 * English-only and un-prefixed, like every other twin: an endpoint runs
 * outside Paraglide's per-render locale storage, so the thunks resolve to the
 * source locale, which is what we want.
 *
 * Same order as the HTML page — differences, price, migration, FAQ,
 * sources — and the same numbers: the receipts are priced with the functions
 * the page and the calculator use, so the three can't disagree.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { competitorBySlug, competitors, type Competitor } from "../../lib/competitors"
import { absolute, blocks, docHeader, markdown, table } from "../../lib/page-markdown"
import * as m from "../../paraglide/messages.js"
import {
	defaultValues,
	describeWorkload,
	estimateMaple,
	estimateVendor,
	MAPLE_PRICING_NOTE,
	PRICES_VERIFIED,
	vendorCaveat,
	vendorConfigs,
} from "../../lib/vendor-pricing"

export const getStaticPaths: GetStaticPaths = () =>
	competitors.map((competitor) => ({ params: { slug: competitor.slug }, props: { competitor } }))

const monthLabel = (checked: string) =>
	new Date(`${checked}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })

const dollars = (amount: number) => `$${Math.round(amount).toLocaleString()}`

/** Pipes inside a cell would break the row. */
const cell = (text: string) => text.replace(/\|/g, "\\|")

export const GET: APIRoute = ({ props, site }) => {
	const { competitor } = props as { competitor: Competitor }
	const name = competitor.name

	const edgeLabel = (edge: Competitor["differences"][number]["edge"]) =>
		edge === "maple" ? "Maple" : edge === "competitor" ? name : m.cmp_diff_edge_even()

	const rowsFor = (edge: "differ" | "ahead") =>
		competitor.differences
			.filter((row) => (edge === "ahead" ? row.edge === "competitor" : row.edge !== "competitor"))
			.map((row) => [
				cell(row.topic()),
				cell(row.maple()),
				cell(row.competitor()) + (row.source !== undefined ? ` [${row.source + 1}]` : ""),
				edgeLabel(row.edge),
			])

	const differences = blocks(
		`## ${m.cmp_diff_title({ name })}`,
		m.cmp_diff_lede(),
		`### ${m.cmp_diff_group_differ()}`,
		table([m.cmp_diff_col_topic(), "Maple", name, m.cmp_diff_col_edge()], rowsFor("differ")),
		rowsFor("ahead").length > 0 ? `### ${m.cmp_diff_group_ahead({ name })}` : undefined,
		rowsFor("ahead").length > 0
			? table([m.cmp_diff_col_topic(), "Maple", name, m.cmp_diff_col_edge()], rowsFor("ahead"))
			: undefined,
		`**${m.cmp_parity_label()}:** ${competitor.parity.map((item) => item()).join(" · ")}`,
	)

	const values = defaultValues(competitor.vendor)
	const config = vendorConfigs[competitor.vendor]
	const maple = estimateMaple(competitor.vendor, values)
	const theirs = estimateVendor(competitor.vendor, values)
	const delta = theirs.total - maple.total
	const receipt = (label: string, estimate: typeof maple) =>
		table(
			[label, "Amount"],
			[
				...estimate.breakdown.map((item) => [`${item.label} — ${item.detail}`, item.value === 0 ? m.cmp_price_free() : dollars(item.value)]),
				["**Total**", `**${dollars(estimate.total)}**`],
			],
		)

	const price = blocks(
		`## ${m.cmp_price_title()}`,
		m.cmp_price_lede(),
		`**${m.cmp_price_workload()}:** ${describeWorkload(competitor.vendor, values)}`,
		receipt("Maple", maple),
		receipt(config.name, theirs),
		delta >= 0 ? m.cmp_price_less({ amount: dollars(delta) }) : m.cmp_price_more({ amount: dollars(-delta) }),
		`${m.cmp_price_verified({ date: monthLabel(PRICES_VERIFIED) })} ${MAPLE_PRICING_NOTE} ${vendorCaveat[competitor.vendor]}`,
		`Interactive calculator: ${absolute(site, `/compare/${competitor.slug}#calculator`)}`,
	)

	const migration = blocks(
		`## ${m.cmp_migration_title({ name })}`,
		m.cmp_migration_lede(),
		competitor.migration.map((step, i) => `${i + 1}. **${step.title()}** ${step.body()}`).join("\n"),
		`\`\`\`yaml\n# otel-collector.yaml — ${m.cmp_migration_diff_caption()}\n${competitor.migrationDiff}\n\`\`\``,
	)

	const faq = blocks(`## ${m.faq_heading()}`, ...competitor.faqs.map((f) => `### ${f.question()}\n\n${f.answer()}`))

	const sources = blocks(
		`## ${m.cmp_sources_title({ name })}`,
		m.cmp_sources_lede(),
		competitor.sources
			.map((s, i) => `${i + 1}. [${s.label}](${s.url}) — ${m.cmp_sources_checked({ date: monthLabel(s.checked) })}`)
			.join("\n"),
	)

	const related = blocks(
		`## ${m.cmp_related_title()}`,
		competitor.related
			.map((slug) => {
				const entry = competitorBySlug(slug)
				return entry ? `- [${entry.navLabel()}](${absolute(site, `/compare/${slug}.md`)})` : ""
			})
			.join("\n"),
	)

	return markdown(
		blocks(docHeader(competitor.heroTitle(), competitor.heroLede()), differences, price, migration, faq, sources, related),
	)
}
