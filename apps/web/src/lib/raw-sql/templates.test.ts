import { describe, expect, it } from "vitest"
import { RAW_SQL_TEMPLATES, visualizationToDisplayType } from "@/lib/raw-sql/templates"
import { fromPanelType } from "@/lib/query-builder/panel-types"

describe("visualizationToDisplayType", () => {
	it("maps gauge onto the scalar stat shape", () => {
		// RawSqlDisplayType has no `gauge` member — a gauge is a scalar on an arc,
		// the same single-row shape as a stat. Mirrors the API-side mapping in
		// apps/api/src/mcp/lib/raw-sql-widget.ts; without this a raw-SQL gauge fell
		// through to "line" and fed a timeseries into GaugeWidget.
		expect(visualizationToDisplayType("gauge")).toBe("stat")
	})

	it("derives line/bar/area from the chart's chartId", () => {
		expect(visualizationToDisplayType("chart", "query-builder-line")).toBe("line")
		expect(visualizationToDisplayType("chart", "query-builder-bar")).toBe("bar")
		expect(visualizationToDisplayType("chart", "query-builder-area")).toBe("area")
	})

	it("maps each breakdown visualization to its own display type", () => {
		for (const panel of ["pie", "histogram", "heatmap", "funnel"] as const) {
			const { visualization, chartId } = fromPanelType(panel)
			expect(visualizationToDisplayType(visualization, chartId), panel).toBe(panel)
		}
	})

	it("has a template for every display type a panel type can produce", () => {
		for (const panel of ["line", "bar", "area", "stat", "gauge", "table", "pie", "funnel"] as const) {
			const { visualization, chartId } = fromPanelType(panel)
			const displayType = visualizationToDisplayType(visualization, chartId)
			expect(RAW_SQL_TEMPLATES[displayType], panel).toBeTruthy()
		}
	})

	it("keeps line/bar/area on one shared template so switching among them is a no-op", () => {
		expect(RAW_SQL_TEMPLATES.line).toBe(RAW_SQL_TEMPLATES.bar)
		expect(RAW_SQL_TEMPLATES.line).toBe(RAW_SQL_TEMPLATES.area)
	})

	it("scopes every template to the org via $__orgFilter", () => {
		for (const [displayType, sql] of Object.entries(RAW_SQL_TEMPLATES)) {
			expect(sql, displayType).toContain("$__orgFilter")
		}
	})
})
