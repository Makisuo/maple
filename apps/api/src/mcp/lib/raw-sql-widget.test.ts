import { describe, expect, it } from "vitest"
import { buildRawSqlDataSource, validateRawSqlMacro, visualizationToDisplayType } from "./raw-sql-widget"

describe("visualizationToDisplayType", () => {
	it("maps direct visualization kinds 1:1", () => {
		expect(visualizationToDisplayType("table")).toBe("table")
		expect(visualizationToDisplayType("stat")).toBe("stat")
		expect(visualizationToDisplayType("pie")).toBe("pie")
		expect(visualizationToDisplayType("histogram")).toBe("histogram")
		expect(visualizationToDisplayType("heatmap")).toBe("heatmap")
		expect(visualizationToDisplayType("funnel")).toBe("funnel")
	})

	it("derives line/area/bar for chart based on chartId hint", () => {
		expect(visualizationToDisplayType("chart")).toBe("line")
		expect(visualizationToDisplayType("chart", "area-chart")).toBe("area")
		expect(visualizationToDisplayType("chart", "bar-chart")).toBe("bar")
		expect(visualizationToDisplayType("chart", "line-chart")).toBe("line")
	})

	it("defaults unknown visualizations to line", () => {
		expect(visualizationToDisplayType("list")).toBe("line")
		expect(visualizationToDisplayType("unknown")).toBe("line")
	})
})

describe("buildRawSqlDataSource", () => {
	it("returns a raw_sql data source with its fields hoisted", () => {
		const result = buildRawSqlDataSource({
			visualization: "chart",
			sql: "SELECT 1 WHERE $__orgFilter",
			displayType: "line",
		})
		// v3: no endpoint string, and the payload sits on the arm itself rather
		// than inside an opaque `params` bag.
		expect(result).toEqual({
			kind: "raw_sql",
			sql: "SELECT 1 WHERE $__orgFilter",
			displayType: "line",
		})
	})

	it("includes granularitySeconds when provided", () => {
		const result = buildRawSqlDataSource({
			visualization: "chart",
			sql: "SELECT 1 WHERE $__orgFilter",
			displayType: "line",
			granularitySeconds: 60,
		})
		expect(result.granularitySeconds).toBe(60)
	})

	it("omits granularitySeconds when null/undefined", () => {
		const result = buildRawSqlDataSource({
			visualization: "chart",
			sql: "SELECT 1 WHERE $__orgFilter",
			displayType: "line",
		})
		expect(result).not.toHaveProperty("granularitySeconds")
	})

	it("auto-injects reduceToValue transform for stat widgets", () => {
		const result = buildRawSqlDataSource({
			visualization: "stat",
			sql: "SELECT count() AS value WHERE $__orgFilter",
			displayType: "stat",
		})
		expect(result.transform?.reduceToValue).toEqual({
			field: "value",
			aggregate: "first",
		})
	})

	it("does not inject reduceToValue for non-stat widgets", () => {
		const result = buildRawSqlDataSource({
			visualization: "table",
			sql: "SELECT * WHERE $__orgFilter",
			displayType: "table",
		})
		expect(result.transform).toBeUndefined()
	})
})

describe("validateRawSqlMacro", () => {
	it("returns null when $__orgFilter is present", () => {
		expect(validateRawSqlMacro("SELECT 1 WHERE $__orgFilter")).toBeNull()
		expect(validateRawSqlMacro("SELECT 1 WHERE foo = 1 AND $__orgFilter")).toBeNull()
	})

	it("returns an error message when $__orgFilter is missing", () => {
		const err = validateRawSqlMacro("SELECT 1")
		expect(err).not.toBeNull()
		expect(err).toContain("$__orgFilter")
	})
})
