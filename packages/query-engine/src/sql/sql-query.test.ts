import { describe, expect, it } from "vitest"
import { raw, str, int, ident, as_, when } from "./sql-fragment"
import { compileQuery } from "./sql-query"

describe("compileQuery", () => {
	it("compiles a basic SELECT query", () => {
		const sql = compileQuery({
			select: [as_(raw("count()"), "count")],
			from: ident("traces"),
			where: [raw("OrgId = 'test'")],
			groupBy: [],
			orderBy: [],
		})

		expect(sql).toBe(
			`SELECT\n          count() AS count\n        FROM traces\n        WHERE OrgId = 'test'`,
		)
	})

	it("compiles with GROUP BY and ORDER BY", () => {
		const sql = compileQuery({
			select: [ident("bucket"), as_(raw("count()"), "count")],
			from: ident("traces"),
			where: [raw("OrgId = 'test'")],
			groupBy: [ident("bucket")],
			orderBy: [raw("bucket ASC")],
		})

		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
	})

	it("includes LIMIT when provided", () => {
		const sql = compileQuery({
			select: [ident("name")],
			from: ident("traces"),
			where: [],
			groupBy: [],
			orderBy: [],
			limit: int(10),
		})

		expect(sql).toContain("LIMIT 10")
	})

	it("includes FORMAT when provided", () => {
		const sql = compileQuery({
			select: [ident("name")],
			from: ident("traces"),
			where: [],
			groupBy: [],
			orderBy: [],
			format: "JSON",
		})

		expect(sql).toContain("FORMAT JSON")
	})

	it("filters out When(false) from WHERE clauses", () => {
		const sql = compileQuery({
			select: [as_(raw("count()"), "count")],
			from: ident("traces"),
			where: [
				raw("OrgId = 'test'"),
				when(false, raw("ServiceName = 'api'")),
				raw("Timestamp >= '2024-01-01'"),
			],
			groupBy: [],
			orderBy: [],
		})

		expect(sql).not.toContain("ServiceName")
		expect(sql).toContain("OrgId = 'test'\n          AND Timestamp >= '2024-01-01'")
	})

	it("omits WHERE when all clauses are When(false)", () => {
		const sql = compileQuery({
			select: [as_(raw("count()"), "count")],
			from: ident("traces"),
			where: [when(false, raw("x = 1"))],
			groupBy: [],
			orderBy: [],
		})

		expect(sql).not.toContain("WHERE")
	})
})
