import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	ClickHouseStatement,
	ClickHouseStatementFromString,
	parseStatement,
	renderStatement,
	withFormat,
	withSettings,
} from "./statement"

describe("parseStatement / renderStatement", () => {
	it("round-trips a statement with both clauses", () => {
		const sql = "SELECT 1\nSETTINGS max_threads=2\nFORMAT JSON"
		expect(renderStatement(parseStatement(sql))).toBe(sql)
	})

	it("normalizes the legacy clause order on the way back out", () => {
		expect(renderStatement(parseStatement("SELECT 1 FORMAT JSON SETTINGS max_threads=2"))).toBe(
			"SELECT 1\nSETTINGS max_threads=2\nFORMAT JSON",
		)
	})

	it("exposes the rendered text on the instance", () => {
		expect(parseStatement("SELECT 1 FORMAT JSON").text).toBe("SELECT 1\nFORMAT JSON")
	})

	it("keeps the body free of terminal clauses so it is safe to nest", () => {
		expect(parseStatement("SELECT 1 SETTINGS max_threads=2 FORMAT JSON").body).toBe("SELECT 1")
	})

	it("renders a bare body unchanged", () => {
		expect(renderStatement(parseStatement("SELECT 1"))).toBe("SELECT 1")
	})
})

describe("withSettings / withFormat", () => {
	const base = parseStatement("SELECT 1")

	it("adds clauses in grammar order", () => {
		const statement = withFormat(withSettings(base, "SETTINGS max_threads=2"), "FORMAT JSON")
		expect(statement.text).toBe("SELECT 1\nSETTINGS max_threads=2\nFORMAT JSON")
	})

	it("drops a clause with undefined", () => {
		const statement = parseStatement("SELECT 1 SETTINGS max_threads=2 FORMAT JSON")
		expect(withFormat(statement, undefined).text).toBe("SELECT 1\nSETTINGS max_threads=2")
		expect(withSettings(statement, undefined).text).toBe("SELECT 1\nFORMAT JSON")
	})

	it("replaces rather than appends", () => {
		const statement = parseStatement("SELECT 1 SETTINGS max_threads=2")
		expect(withSettings(statement, "SETTINGS max_threads=8").text).toBe(
			"SELECT 1\nSETTINGS max_threads=8",
		)
	})

	it("cannot swallow a clause behind a trailing comment", () => {
		const statement = withSettings(parseStatement("SELECT 1 -- note"), "SETTINGS max_threads=2")
		expect(statement.text).toBe("SELECT 1 -- note\nSETTINGS max_threads=2")
	})
})

describe("ClickHouseStatementFromString", () => {
	const decode = Schema.decodeUnknownSync(ClickHouseStatementFromString)
	const encode = Schema.encodeSync(ClickHouseStatementFromString)

	it("decodes text into the parsed shape", () => {
		const statement = decode("SELECT 1 SETTINGS max_threads=2 FORMAT JSON")
		expect(statement).toBeInstanceOf(ClickHouseStatement)
		expect(statement.body).toBe("SELECT 1")
		expect(statement.settings).toBe("SETTINGS max_threads=2")
		expect(statement.format).toBe("FORMAT JSON")
	})

	it("encodes back to SQL text", () => {
		expect(encode(decode("SELECT 1\nFORMAT JSON"))).toBe("SELECT 1\nFORMAT JSON")
	})

	it("decodes a statement with no terminal clause", () => {
		const statement = decode("SELECT format FROM t")
		expect(statement.body).toBe("SELECT format FROM t")
		expect(statement.settings).toBeUndefined()
		expect(statement.format).toBeUndefined()
	})
})
