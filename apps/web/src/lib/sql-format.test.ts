import { describe, expect, it } from "vitest"
import { formatSql } from "./sql-format"

describe("formatSql", () => {
	it("reflows the canonical alert query onto clause/column/condition lines", () => {
		const input =
			"SELECT quantile(0.95)(Duration / 1e6) AS value, count() AS samples FROM traces WHERE ServiceName = 'api-v2' AND SpanName = 'ChartService.getChartData' AND SpanAttributes['cache.fluxSeconds'] = '604800' AND $__timeFilter(Timestamp) AND $__orgFilter"

		expect(formatSql(input)).toBe(
			[
				"SELECT",
				"  quantile(0.95)(Duration / 1e6) AS value,",
				"  count() AS samples",
				"FROM traces",
				"WHERE ServiceName = 'api-v2'",
				"  AND SpanName = 'ChartService.getChartData'",
				"  AND SpanAttributes['cache.fluxSeconds'] = '604800'",
				"  AND $__timeFilter(Timestamp)",
				"  AND $__orgFilter",
			].join("\n"),
		)
	})

	it("never splits commas or parens inside a function call", () => {
		const out = formatSql("SELECT quantile(0.95)(Duration / 1e6) AS v FROM t")
		expect(out).toContain("quantile(0.95)(Duration / 1e6)")
		// the only newline-introduced column line is the single SELECT item
		expect(out).toBe(["SELECT", "  quantile(0.95)(Duration / 1e6) AS v", "FROM t"].join("\n"))
	})

	it("keeps map access and string literals intact", () => {
		const out = formatSql("SELECT a FROM t WHERE SpanAttributes['cache.fluxSeconds'] = '604800'")
		expect(out).toContain("SpanAttributes['cache.fluxSeconds'] = '604800'")
	})

	it("keeps $__macros atomic and breaks the AND before them", () => {
		const out = formatSql("SELECT a FROM t WHERE x = 1 AND $__timeFilter(Timestamp) AND $__orgFilter")
		expect(out).toContain("$__timeFilter(Timestamp)")
		expect(out).toContain("\n  AND $__orgFilter")
	})

	it("never reformats inside string literals", () => {
		const out = formatSql("SELECT 'a, from b WHERE c' AS lit FROM t")
		expect(out).toContain("'a, from b WHERE c'")
		// the literal's lowercase from/where must not be treated as clauses
		expect(out).toBe(["SELECT", "  'a, from b WHERE c' AS lit", "FROM t"].join("\n"))
	})

	it("only breaks top-level AND, not those nested in parentheses", () => {
		const out = formatSql("SELECT a FROM t WHERE (x AND y) AND z")
		expect(out).toBe(["SELECT", "  a", "FROM t", "WHERE (x AND y)", "  AND z"].join("\n"))
	})

	it("does not break GROUP BY columns or the BY keyword", () => {
		const out = formatSql("SELECT a, b FROM t GROUP BY a, b ORDER BY a")
		expect(out).toContain("GROUP BY a, b")
		expect(out).toContain("ORDER BY a")
	})

	it("is idempotent", () => {
		const input =
			"SELECT quantile(0.95)(Duration / 1e6) AS value, count() AS samples FROM traces WHERE a = 1 AND b = 2 AND $__orgFilter"
		const once = formatSql(input)
		expect(formatSql(once)).toBe(once)
	})

	it("returns empty for blank input and does not throw on odd input", () => {
		expect(formatSql("   ")).toBe("")
		expect(() => formatSql("SELECT (((")).not.toThrow()
		expect(() => formatSql("@#$ %^&")).not.toThrow()
	})
})
