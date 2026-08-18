import { describe, expect, it } from "vitest"
import { MCP_PANEL_TYPES, WIDGET_TYPES } from "@maple/domain/http"
import { resolvePanelType } from "./panel-type"

const resolved = (input: Parameters<typeof resolvePanelType>[0]) => {
	const result = resolvePanelType(input)
	if (!result.ok) throw new Error(`expected success, got: ${result.error}`)
	return result.resolved
}

const failure = (input: Parameters<typeof resolvePanelType>[0]) => {
	const result = resolvePanelType(input)
	if (result.ok) throw new Error("expected failure")
	return result.error
}

describe("panel_type derives the whole chart decision", () => {
	for (const panelType of MCP_PANEL_TYPES) {
		it(`${panelType} resolves to its table entry`, () => {
			const result = resolved({ panel_type: panelType })
			expect(result.panelType).toBe(panelType)
			expect(result.visualization).toBe(WIDGET_TYPES[panelType].visualization)
			expect(result.chartId).toBe(WIDGET_TYPES[panelType].chartId)
		})
	}

	// The concrete gap this closed: on the structured-query path there was no way
	// to ask for a bar or an area chart at all, because `visualization` collapses
	// them into `"chart"` and nothing derived `chartId`.
	it("bar and area are reachable and get distinct chart ids", () => {
		expect(resolved({ panel_type: "bar" }).chartId).toBe("query-builder-bar")
		expect(resolved({ panel_type: "area" }).chartId).toBe("query-builder-area")
		expect(resolved({ panel_type: "line" }).chartId).toBe("query-builder-line")
	})

	it("list has no raw-SQL display type, so `list` + sql can be rejected", () => {
		expect(resolved({ panel_type: "list" }).rawSqlDisplayType).toBeUndefined()
		expect(resolved({ panel_type: "table" }).rawSqlDisplayType).toBe("table")
	})

	it("a gauge renders as a stat in raw SQL — there is no gauge display type", () => {
		expect(resolved({ panel_type: "gauge" }).rawSqlDisplayType).toBe("stat")
	})
})

describe("legacy `visualization` still works", () => {
	it("a bare chart means line, as it always has", () => {
		const result = resolved({ visualization: "chart" })
		expect(result.panelType).toBe("line")
	})

	it("a chart with an explicit chartId keeps its family", () => {
		expect(resolved({ visualization: "chart", chartId: "query-builder-bar" }).panelType).toBe("bar")
		expect(resolved({ visualization: "chart", chartId: "query-builder-area" }).panelType).toBe("area")
	})

	it("non-chart visualizations map straight through", () => {
		expect(resolved({ visualization: "pie" }).panelType).toBe("pie")
		expect(resolved({ visualization: "markdown" }).panelType).toBe("markdown")
	})

	it("panel_type wins when both agree", () => {
		expect(resolved({ panel_type: "bar", visualization: "chart" }).panelType).toBe("bar")
	})
})

describe("errors name the fix", () => {
	it("rejects a contradictory pair rather than silently picking one", () => {
		expect(failure({ panel_type: "pie", visualization: "chart" })).toContain("disagree")
	})

	it("points a `visualization` value passed as panel_type at the right panel", () => {
		// `chart` is a legal visualization but not a panel type — the most likely
		// wrong value, so the error says what to use instead.
		expect(failure({ panel_type: "chart" })).toContain("`line`")
	})

	it("lists the legal set for an unknown value", () => {
		const error = failure({ panel_type: "sparkline" })
		expect(error).toContain('"line"')
		expect(error).toContain('"heatmap"')
	})

	it("requires one of the two", () => {
		expect(failure({})).toContain("Missing `panel_type`")
	})

	it("rejects an unknown visualization", () => {
		expect(failure({ visualization: "donut" })).toContain("must be one of")
	})
})
