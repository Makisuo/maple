import { describe, expect, it } from "vitest"
import { parseTableMap, remapTables } from "./table-map"

describe("parseTableMap", () => {
	it("parses from=to entries and skips blanks", () => {
		const map = parseTableMap(["traces=traces_t2", " logs = logs_l2 ", ""])
		expect(map.get("traces")).toBe("traces_t2")
		expect(map.get("logs")).toBe("logs_l2")
		expect(map.size).toBe(2)
	})

	it("rejects malformed entries", () => {
		expect(() => parseTableMap(["traces"])).toThrow()
		expect(() => parseTableMap(["=traces_t2"])).toThrow()
		expect(() => parseTableMap(["traces="])).toThrow()
	})
})

describe("remapTables", () => {
	const map = parseTableMap(["traces=traces_t2", "logs=logs_l2"])

	it("rewrites FROM and JOIN table positions", () => {
		expect(remapTables("SELECT * FROM traces WHERE OrgId = 'x'", map)).toBe(
			"SELECT * FROM traces_t2 WHERE OrgId = 'x'",
		)
		expect(remapTables("SELECT * FROM a JOIN logs ON a.id = logs.id", map)).toContain("JOIN logs_l2 ON")
	})

	it("does NOT touch longer table names that share a prefix", () => {
		// `traces` rule must not clobber trace_detail_spans / traces_aggregates_hourly.
		expect(remapTables("SELECT * FROM trace_detail_spans", map)).toBe("SELECT * FROM trace_detail_spans")
		expect(remapTables("SELECT * FROM traces_aggregates_hourly", map)).toBe(
			"SELECT * FROM traces_aggregates_hourly",
		)
	})

	it("does NOT rewrite the name outside a FROM/JOIN position", () => {
		// A column or literal that happens to equal a table name is left alone.
		expect(remapTables("SELECT traces FROM x WHERE note = 'traces'", map)).toBe(
			"SELECT traces FROM x WHERE note = 'traces'",
		)
	})

	it("is a no-op for an empty map", () => {
		const sql = "SELECT * FROM traces"
		expect(remapTables(sql, parseTableMap([]))).toBe(sql)
	})
})
