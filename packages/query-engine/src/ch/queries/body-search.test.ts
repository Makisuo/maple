import { describe, expect, it } from "vitest"
import { compileCH, from } from "@maple-dev/clickhouse-builder"
import { Logs } from "../tables"
import { bodySearchConditions, extractSafeSearchTokens } from "./body-search"

// ---------------------------------------------------------------------------
// extractSafeSearchTokens — only interior, separator-bounded ASCII tokens
// ---------------------------------------------------------------------------

describe("extractSafeSearchTokens", () => {
	it.each([
		// A single word is one edge-to-edge run — no interior boundary, so unsafe
		// (it could be a prefix/suffix of a longer token in Body).
		["exception", []],
		["timeout", []],
		// Interior tokens are bounded on both sides by separators within the term.
		["error: user 42 timeout", ["user", "42"]],
		["GET /api/users failed", ["api", "users"]],
		// Lowercased to match the `lower(Body)` index.
		["a FOO b", ["foo"]],
		// Underscore is not treated as a separator (tokenizer-version-safe).
		["foo_bar baz qux", ["baz"]],
		// Non-ASCII disables the pre-filter entirely (JS/CH lower() divergence).
		["café con leche", []],
		// Dedup: the second "user" is dropped; edge tokens x/z excluded, y kept.
		["x user y user z", ["user", "y"]],
		// Empty / whitespace.
		["", []],
		["   ", []],
	])("extractSafeSearchTokens(%j) = %j", (term, expected) => {
		expect(extractSafeSearchTokens(term)).toEqual(expected)
	})

	it("caps at 4 tokens", () => {
		expect(extractSafeSearchTokens("a b c d e f g h").length).toBe(4)
	})
})

// ---------------------------------------------------------------------------
// bodySearchConditions — compiled SQL shape
// ---------------------------------------------------------------------------

function whereSql(term: string): string {
	const q = from(Logs)
		.select(($) => ({ body: $.Body }))
		.where(($) => bodySearchConditions($.Body, term))
		.format("JSON")
	return compileCH(q, {}).sql
}

describe("bodySearchConditions", () => {
	it("emits hasToken pre-filters plus the substring ILIKE for a phrase", () => {
		const sql = whereSql("error: user 42 timeout")
		expect(sql).toContain("hasToken(lower(Body), 'user')")
		expect(sql).toContain("hasToken(lower(Body), '42')")
		expect(sql).toContain("Body ILIKE '%error: user 42 timeout%'")
	})

	it("degrades to ILIKE only for a single word (no safe token)", () => {
		const sql = whereSql("exception")
		expect(sql).not.toContain("hasToken")
		expect(sql).toContain("Body ILIKE '%exception%'")
	})
})
