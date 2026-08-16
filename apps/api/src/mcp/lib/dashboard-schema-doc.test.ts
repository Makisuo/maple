import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	DashboardWidgetSchema,
	PANEL_TYPES,
	WIDGET_UNIT_TOKENS,
	WidgetDataSourceSchema,
} from "@maple/domain/http"
import { AGGREGATIONS_BY_SOURCE, GROUP_BY_TOKENS } from "@maple/query-engine/query-builder"
import {
	DASHBOARD_SCHEMA_SECTIONS,
	renderDashboardSchemaIndex,
	renderDashboardSchemaSection,
} from "./dashboard-schema-doc"

const decodeDataSource = Schema.decodeUnknownSync(WidgetDataSourceSchema)
const decodeWidget = Schema.decodeUnknownSync(DashboardWidgetSchema)

const allSections = () =>
	[renderDashboardSchemaIndex(), ...DASHBOARD_SCHEMA_SECTIONS.map(renderDashboardSchemaSection)].join("\n")

/** Every ```json fence in the generated doc. */
const jsonExamples = (markdown: string): ReadonlyArray<unknown> => {
	const blocks = markdown.matchAll(/```json\n([\s\S]*?)\n```/g)
	return [...blocks].map(([, body]) => JSON.parse(body!))
}

describe("generated JSON examples decode", () => {
	// The test that would have caught the original drift on day one: the docs
	// taught the v2 `{ endpoint, params }` data source for months after the
	// decoders moved to the v3 `kind` union, so an agent following them exactly
	// produced a payload that could not decode.
	it("every data-source example is accepted by the live schema", () => {
		const examples = jsonExamples(renderDashboardSchemaSection("data_sources"))
		expect(examples.length).toBeGreaterThan(0)
		for (const example of examples) {
			// The whole-widget example decodes through the widget schema instead;
			// everything else in this section is a bare data source.
			const decode = Object.hasOwn(example as object, "dataSource") ? decodeWidget : decodeDataSource
			expect(() => decode(example)).not.toThrow()
		}
	})

	it("the section includes a complete widget, not only data sources", () => {
		// `update_dashboard_widget` / `replace_dashboard_widgets` / `dashboard_json`
		// all take an assembled widget. Every agent in the documentation A/B
		// inferred that envelope correctly but reported it as a guess.
		const examples = jsonExamples(renderDashboardSchemaSection("data_sources"))
		const widgets = examples.filter((example) => Object.hasOwn(example as object, "dataSource"))
		expect(widgets).toHaveLength(1)
		expect(() => decodeWidget(widgets[0])).not.toThrow()
	})

	it("no example uses the retired v2 shape", () => {
		for (const example of jsonExamples(allSections())) {
			expect(example).not.toHaveProperty("endpoint")
			expect(example).not.toHaveProperty("params")
		}
	})
})

describe("coverage", () => {
	it("documents every MCP-exposed panel type", () => {
		const doc = renderDashboardSchemaSection("panel_types")
		for (const meta of PANEL_TYPES.filter((panel) => panel.mcpExposed)) {
			expect(doc).toContain(`\`${meta.panelType}\``)
		}
	})

	it("documents every unit token", () => {
		const doc = renderDashboardSchemaSection("units")
		for (const token of WIDGET_UNIT_TOKENS) {
			expect(doc).toContain(`\`${token}\``)
		}
	})

	it("documents every aggregation the builder accepts", () => {
		const doc = renderDashboardSchemaSection("queries")
		for (const source of ["traces", "logs", "metrics"] as const) {
			for (const option of AGGREGATIONS_BY_SOURCE[source]) {
				expect(doc).toContain(`\`${option.value}\``)
			}
		}
	})

	it("documents every group-by token the resolvers accept", () => {
		const doc = renderDashboardSchemaSection("queries")
		for (const source of ["traces", "logs", "metrics"] as const) {
			for (const token of GROUP_BY_TOKENS[source].literals) {
				expect(doc).toContain(`\`${token}\``)
			}
		}
	})

	it("states the percent scale rule in the units section", () => {
		const doc = renderDashboardSchemaSection("units")
		expect(doc).toContain("percent_100")
		expect(doc).toMatch(/0–1|0-1/)
		expect(doc).toContain("Grafana")
	})

	it("marks the display keys that are stored but never rendered", () => {
		const doc = renderDashboardSchemaSection("display")
		// Advertising an inert key is worse than omitting it: an agent sets
		// `yAxis.max` to fix a percent gauge and believes it worked.
		for (const key of ["yAxis.min", "seriesMapping", "colorOverrides", "gauge.style"]) {
			expect(doc).toContain(key)
		}
		expect(doc).toContain("Stored but not rendered")
	})

	it("warns that `list` has no raw-SQL rendering", () => {
		expect(renderDashboardSchemaSection("raw_sql")).toContain("not supported")
	})
})

describe("no stale references", () => {
	// Each string here is a defect that actually shipped in the hand-written docs.
	const RETIRED = [
		"custom_query_builder_",
		"markdown_static",
		"raw_sql_chart",
		"list_dashboard_templates",
		"params.queries",
	]

	it("the generated doc names none of the retired identifiers", () => {
		const doc = allSections()
		for (const needle of RETIRED) {
			expect(doc).not.toContain(needle)
		}
	})

	it("does not advertise bare percentiles as metrics aggregations", () => {
		const doc = renderDashboardSchemaSection("queries")
		// `p95` appears legitimately under the traces `valueField` mode; what must
		// not appear is the claim that metrics accept it.
		expect(doc).toContain("Metrics never accept percentiles")
	})
})
