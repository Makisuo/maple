/**
 * `/compare.md` — the comparison hub, serialized: one line per page, then the
 * line-item bill for every vendor on one sheet.
 */
import type { APIRoute } from "astro"
import { competitors } from "../lib/competitors"
import { absolute, blocks, docHeader, markdown, table } from "../lib/page-markdown"
import * as m from "../paraglide/messages.js"

export const GET: APIRoute = ({ site }) => {
	const pages = blocks(
		`## ${m.cmp_hub_pages_title()}`,
		competitors
			.map(
				(c) =>
					`- [${c.navLabel()}](${absolute(site, `/compare/${c.slug}.md`)}) — ${c.navDesc()} (HTML: ${absolute(site, `/compare/${c.slug}`)})`,
			)
			.join("\n"),
	)

	// Mirrors BillComparison.astro cell for cell.
	const bill = blocks(
		`## ${m.cmp_hub_matrix_title()}`,
		m.bill_lede(),
		table(
			[m.bill_col_metric(), "Maple", "Datadog", "New Relic", "Grafana Cloud", "Dash0"],
			[
				[m.bill_row_per_host(), m.bill_v_none(), "$15+ / host / mo", m.bill_v_bundled(), m.bill_v_bundled(), m.bill_v_none()],
				[m.bill_row_per_seat(), m.bill_v_none(), m.bill_v_enterprise(), "$99–349 / full-user / mo", "$8+ / active-user / mo", m.bill_v_none()],
				[m.bill_row_ingest(), m.bill_v_usage(), "$0.10 / GB + $1.70 / M indexed", "$0.40 / GB", "$0.45 / GB", "$0.60 / M spans or logs"],
				[m.bill_row_retention(), "30d default · custom", "15d default", "30d logs · 8d traces", "30d logs/traces · 13mo metrics", "Per plan tier"],
				[m.bill_row_otel(), m.bill_v_native(), m.bill_v_partial(), m.bill_v_yes(), m.bill_v_yes(), m.bill_v_native()],
				[m.bill_row_oss(), m.bill_v_apache(), m.bill_v_proprietary(), m.bill_v_proprietary(), "AGPL components", m.bill_v_proprietary()],
				[m.bill_row_selfhost(), m.bill_v_supported(), m.bill_v_no(), m.bill_v_no(), m.bill_v_oss_only(), m.bill_v_no()],
				[m.bill_row_mcp(), m.bill_v_first_class(), m.bill_v_yes(), m.bill_v_yes(), m.bill_v_yes(), m.bill_v_yes()],
			],
		),
		m.bill_footnote(),
	)

	return markdown(blocks(docHeader(m.cmp_hub_title(), m.cmp_hub_lede()), pages, bill))
}
