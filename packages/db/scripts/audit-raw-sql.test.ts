import { describe, expect, it } from "vitest"
import { rawSqlWidgets } from "./audit-raw-sql"

// The walker returning nothing reads as "all clear", which is the one wrong
// answer an audit must not give — so pin the document shapes it has to find.
describe("rawSqlWidgets", () => {
	it("finds a raw_sql data source on a widget", () => {
		const payload = {
			widgets: [
				{ id: "w0", dataSource: { kind: "query", queries: [] } },
				{ id: "w1", dataSource: { kind: "raw_sql", sql: "SELECT 1" } },
			],
		}
		expect(rawSqlWidgets(payload)).toEqual([{ widgetId: "w1", sql: "SELECT 1", sourceForm: "kind" }])
	})

	it("attributes the sql to the nearest enclosing id", () => {
		const payload = { widgets: [{ id: "w7", dataSource: { kind: "raw_sql", sql: "SELECT 2" } }] }
		expect(rawSqlWidgets(payload)[0]?.widgetId).toBe("w7")
	})

	it("finds several, including nested ones", () => {
		const payload = {
			widgets: [
				{ id: "a", dataSource: { kind: "raw_sql", sql: "SELECT 1" } },
				{ id: "b", panels: [{ id: "b1", dataSource: { kind: "raw_sql", sql: "SELECT 2" } }] },
			],
		}
		expect(rawSqlWidgets(payload)).toEqual([
			{ widgetId: "a", sql: "SELECT 1", sourceForm: "kind" },
			{ widgetId: "b1", sql: "SELECT 2", sourceForm: "kind" },
		])
	})

	it("ignores a raw_sql marker with no sql string", () => {
		expect(rawSqlWidgets({ widgets: [{ id: "w", dataSource: { kind: "raw_sql" } }] })).toEqual([])
	})

	// Live documents are v3, but the pre-v3 form is still what `/v2/dashboards`
	// speaks and what any un-backfilled row would hold — the accessor reads both,
	// and the audit must not quietly stop at the current one.
	it("finds the pre-v3 endpoint/params shape", () => {
		const payload = {
			widgets: [{ id: "old", dataSource: { endpoint: "raw_sql_chart", params: { sql: "SELECT 3" } } }],
		}
		expect(rawSqlWidgets(payload)).toEqual([{ widgetId: "old", sql: "SELECT 3", sourceForm: "route" }])
	})

	it("finds both shapes in one document", () => {
		const payload = {
			widgets: [
				{ id: "v3", dataSource: { kind: "raw_sql", sql: "SELECT 1" } },
				{ id: "v2", dataSource: { endpoint: "raw_sql_chart", params: { sql: "SELECT 2" } } },
			],
		}
		expect(rawSqlWidgets(payload).map((w) => [w.widgetId, w.sourceForm])).toEqual([
			["v3", "kind"],
			["v2", "route"],
		])
	})

	it("survives nulls and non-objects", () => {
		expect(rawSqlWidgets(null)).toEqual([])
		expect(rawSqlWidgets({ widgets: [null, 3, "x", undefined] })).toEqual([])
	})
})
