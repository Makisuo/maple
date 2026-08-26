import { describe, expect, it } from "vitest"
import { maskLiteralsAndComments, splitTerminalClauses } from "./terminal-clauses"

describe("maskLiteralsAndComments", () => {
	it("preserves offsets so matches index the original", () => {
		const sql = "SELECT 'a FORMAT JSON' AS x -- FORMAT CSV\nFROM t"
		const masked = maskLiteralsAndComments(sql)
		expect(masked.length).toBe(sql.length)
		expect(masked).not.toMatch(/FORMAT/)
		expect(masked.indexOf("FROM t")).toBe(sql.indexOf("FROM t"))
	})

	it("keeps newlines inside block comments", () => {
		const masked = maskLiteralsAndComments("SELECT 1 /* a\nb */ FROM t")
		expect(masked).toBe("SELECT 1     \n     FROM t")
	})

	it("handles doubled and backslash-escaped quotes", () => {
		const sql = "SELECT 'it''s', 'a\\'b' FROM t"
		const masked = maskLiteralsAndComments(sql)
		expect(masked.length).toBe(sql.length)
		expect(masked.trimEnd().endsWith("FROM t")).toBe(true)
	})
})

describe("splitTerminalClauses", () => {
	it("returns the whole statement when there is no terminal clause", () => {
		expect(splitTerminalClauses("SELECT 1")).toEqual({
			body: "SELECT 1",
			settings: undefined,
			format: undefined,
		})
	})

	it("splits a trailing FORMAT", () => {
		expect(splitTerminalClauses("SELECT 1\nFORMAT JSON")).toEqual({
			body: "SELECT 1",
			settings: undefined,
			format: "FORMAT JSON",
		})
	})

	it("drops a trailing semicolon", () => {
		expect(splitTerminalClauses("SELECT 1 FORMAT JSONEachRow;")).toEqual({
			body: "SELECT 1",
			settings: undefined,
			format: "FORMAT JSONEachRow",
		})
	})

	it("splits both clauses in grammar order", () => {
		expect(splitTerminalClauses("SELECT 1 SETTINGS max_threads=2 FORMAT JSON")).toEqual({
			body: "SELECT 1",
			settings: "SETTINGS max_threads=2",
			format: "FORMAT JSON",
		})
	})

	it("splits both clauses in legacy order", () => {
		expect(splitTerminalClauses("SELECT 1 FORMAT JSON SETTINGS max_threads=2")).toEqual({
			body: "SELECT 1",
			settings: "SETTINGS max_threads=2",
			format: "FORMAT JSON",
		})
	})

	it("ignores FORMAT inside a string literal", () => {
		const sql = "SELECT concat(a, ' FORMAT JSON') FROM t"
		expect(splitTerminalClauses(sql).body).toBe(sql)
		expect(splitTerminalClauses(sql).format).toBeUndefined()
	})

	it("ignores FORMAT inside a trailing comment", () => {
		expect(splitTerminalClauses("SELECT 1 FROM t -- FORMAT JSON").format).toBeUndefined()
	})

	it("ignores FORMAT inside a subquery", () => {
		expect(splitTerminalClauses("SELECT * FROM (SELECT 1 FORMAT JSON) AS x").format).toBeUndefined()
	})

	it("ignores a column named format", () => {
		expect(splitTerminalClauses("SELECT format FROM t").format).toBeUndefined()
		expect(splitTerminalClauses("SELECT format, count() FROM t").format).toBeUndefined()
	})

	it("ignores a column named settings", () => {
		expect(splitTerminalClauses("SELECT settings FROM t").settings).toBeUndefined()
	})

	it("does not match a keyword prefix", () => {
		const sql = "SELECT formatDateTime(now(), '%F') AS format_col FROM t"
		expect(splitTerminalClauses(sql).format).toBeUndefined()
	})

	it("splits a multi-line SETTINGS clause", () => {
		expect(splitTerminalClauses("SELECT 1\nSETTINGS max_execution_time=10,\n  max_threads=2")).toEqual({
			body: "SELECT 1",
			settings: "SETTINGS max_execution_time=10,\n  max_threads=2",
			format: undefined,
		})
	})

	it("keeps the last FORMAT when an earlier one is only an identifier", () => {
		expect(splitTerminalClauses("SELECT format FROM t FORMAT JSON")).toEqual({
			body: "SELECT format FROM t",
			settings: undefined,
			format: "FORMAT JSON",
		})
	})
})
