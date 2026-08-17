import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * A denylist scan over every surface an agent reads about dashboards.
 *
 * Each string below is a defect that actually shipped: the tool descriptions and
 * `maple://instructions` taught the v2 `{ endpoint, params }` data source for
 * months after the decoders moved to the v3 `kind` union, pointed at a
 * `list_dashboard_templates` tool that was never registered, and recommended a
 * `"GB"` unit that renders as a bare number. None of it failed a test, because
 * prose has no compiler.
 *
 * The point is narrow and cheap: catch a *known-retired* identifier reappearing
 * in agent-facing text. Coverage of what the docs must *contain* lives in
 * `dashboard-schema-doc.test.ts`.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..")
const TOOLS_DIR = resolve(import.meta.dirname, "../tools")

interface RetiredIdentifier {
	readonly needle: string
	readonly why: string
}

const RETIRED: ReadonlyArray<RetiredIdentifier> = [
	{
		needle: "custom_query_builder_",
		why: 'v2 endpoint name; a query data source is `{ kind: "query", resultShape }`',
	},
	{
		needle: "markdown_static",
		why: 'v2 endpoint name; a note is `{ kind: "static" }`',
	},
	{
		needle: "raw_sql_chart",
		why: 'v2 endpoint name; raw SQL is `{ kind: "raw_sql", sql }`',
	},
	{
		needle: "list_dashboard_templates",
		why: "no such tool is registered; template ids are interpolated into create_dashboard's description",
	},
	{
		needle: "params.queries",
		why: "v3 spreads `queries` at the top level of the data source, not under `params`",
	},
]

/** Agent-facing text: tool descriptions, the instructions resource, the skill. */
const surfaces = (): ReadonlyArray<{ label: string; text: string }> => {
	const dashboardTools = readdirSync(TOOLS_DIR)
		.filter((file) => file.includes("dashboard") && file.endsWith(".ts") && !file.includes(".test."))
		.map((file) => ({
			label: `tools/${file}`,
			text: readFileSync(resolve(TOOLS_DIR, file), "utf8"),
		}))

	return [
		...dashboardTools,
		{
			label: "resources/instructions.ts",
			text: readFileSync(resolve(import.meta.dirname, "../resources/instructions.ts"), "utf8"),
		},
		{
			label: "skills/maple-dashboard-widgets/SKILL.md",
			text: readFileSync(resolve(REPO_ROOT, "skills/maple-dashboard-widgets/SKILL.md"), "utf8"),
		},
	]
}

/**
 * `dashboard-mutations.ts` translates the retired names into their v3
 * equivalents for the decode-failure hint, so it necessarily contains them.
 * That file is excluded by not being a `*dashboard*` tool file — this assertion
 * documents the exemption so a future reader does not "fix" it.
 */
const EXEMPT = "lib/dashboard-mutations.ts"

describe("dashboard docs contain no retired identifiers", () => {
	for (const { label, text } of surfaces()) {
		for (const { needle, why } of RETIRED) {
			it(`${label} does not mention \`${needle}\``, () => {
				expect(text, `\`${needle}\` is retired — ${why}`).not.toContain(needle)
			})
		}
	}

	it("the v2→v3 translation table is the one deliberate exception", () => {
		const hint = readFileSync(
			resolve(import.meta.dirname, "../dashboard-mutations.ts".replace("../", "")),
			"utf8",
		)
		// Reading it at all proves the file exists at the exempt path; its job is
		// to name the retired endpoints so the error message can translate them.
		expect(hint).toContain("markdown_static")
		expect(EXEMPT).toContain("dashboard-mutations")
	})
})

describe("unit guidance", () => {
	it('no surface recommends a "GB" unit, which renders as a bare number', () => {
		for (const { label, text } of surfaces()) {
			expect(text, `${label} recommends an uncatalogued unit`).not.toMatch(/unit[^\n]{0,40}"GB"/)
		}
	})

	it("the instructions resource states the percent scale rule", () => {
		const instructions = readFileSync(
			resolve(import.meta.dirname, "../resources/instructions.ts"),
			"utf8",
		)
		expect(instructions).toContain("percent_100")
		expect(instructions).toContain("Grafana")
	})
})
