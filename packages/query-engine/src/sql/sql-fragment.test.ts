import { describe, expect, it } from "vitest"
import { compile, raw, str, int, ident, join, as_, when } from "./sql-fragment"

describe("compile", () => {
	describe("Raw", () => {
		it("passes through unchanged", () => {
			expect(compile(raw("count()"))).toBe("count()")
		})

		it("preserves complex ClickHouse syntax", () => {
			expect(compile(raw("quantile(0.95)(Duration) / 1000000"))).toBe(
				"quantile(0.95)(Duration) / 1000000",
			)
		})
	})

	describe("Str", () => {
		it("wraps in single quotes", () => {
			expect(compile(str("hello"))).toBe("'hello'")
		})

		it("escapes single quotes", () => {
			expect(compile(str("it's"))).toBe("'it\\'s'")
		})

		it("escapes backslashes", () => {
			expect(compile(str("a\\b"))).toBe("'a\\\\b'")
		})

		it("escapes both together", () => {
			expect(compile(str("a\\'b"))).toBe("'a\\\\\\'b'")
		})

		it("handles empty string", () => {
			expect(compile(str(""))).toBe("''")
		})

		it("prevents SQL injection", () => {
			const malicious = "'; DROP TABLE traces; --"
			expect(compile(str(malicious))).toBe("'\\'; DROP TABLE traces; --'")
		})
	})

	describe("Int", () => {
		it("converts integer", () => {
			expect(compile(int(42))).toBe("42")
		})

		it("rounds to nearest integer", () => {
			expect(compile(int(3.7))).toBe("4")
		})

		it("handles zero", () => {
			expect(compile(int(0))).toBe("0")
		})

		it("handles negative numbers", () => {
			expect(compile(int(-5))).toBe("-5")
		})
	})

	describe("Ident", () => {
		it("passes identifier through", () => {
			expect(compile(ident("bucket"))).toBe("bucket")
		})

		it("handles table names", () => {
			expect(compile(ident("trace_list_mv"))).toBe("trace_list_mv")
		})
	})

	describe("Join", () => {
		it("joins with separator", () => {
			expect(compile(join(", ", raw("a"), raw("b"), raw("c")))).toBe("a, b, c")
		})

		it("filters empty strings from When(false)", () => {
			expect(compile(join(" AND ", raw("x = 1"), when(false, raw("y = 2")), raw("z = 3")))).toBe(
				"x = 1 AND z = 3",
			)
		})

		it("handles single element", () => {
			expect(compile(join(", ", raw("a")))).toBe("a")
		})

		it("handles all empty", () => {
			expect(compile(join(", ", when(false, raw("a"))))).toBe("")
		})
	})

	describe("As", () => {
		it("aliases an expression", () => {
			expect(compile(as_(raw("count()"), "total"))).toBe("count() AS total")
		})

		it("works with complex expressions", () => {
			expect(compile(as_(raw("avg(Duration) / 1000000"), "avgDuration"))).toBe(
				"avg(Duration) / 1000000 AS avgDuration",
			)
		})
	})

	describe("When", () => {
		it("includes fragment when true", () => {
			expect(compile(when(true, raw("x = 1")))).toBe("x = 1")
		})

		it("produces empty string when false", () => {
			expect(compile(when(false, raw("x = 1")))).toBe("")
		})
	})
})
