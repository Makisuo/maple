import { describe, expect, it } from "vitest"
import {
	escapeJsonInHtml,
	sanitizeCssIdentifier,
	validateCssColor,
	validateInternalRedirect,
	validateUrlScheme,
} from "../sanitizers"

describe("sanitizeCssIdentifier", () => {
	it("escapes CSS terminators", () => {
		const escaped = sanitizeCssIdentifier("</style><script>")
		expect(escaped).not.toContain("<")
		expect(escaped).not.toContain(">")
	})
	it("preserves safe identifiers (passes through CSS.escape)", () => {
		expect(sanitizeCssIdentifier("series-1")).toBe("series-1")
	})
})

describe("validateCssColor", () => {
	it.each(["#fff", "#ffffff", "rgb(0, 0, 0)", "hsl(0 0% 0%)", "var(--color-primary)", "transparent", "currentColor"])(
		"accepts %s",
		(value) => {
			expect(validateCssColor(value)).toBe(value)
		},
	)

	it.each(["red; background:url(http://x)", "</style>", "<script>alert(1)</script>", ";"])(
		"rejects %s",
		(value) => {
			expect(validateCssColor(value)).toBeNull()
		},
	)

	it("rejects empty / null", () => {
		expect(validateCssColor("")).toBeNull()
		expect(validateCssColor(null)).toBeNull()
		expect(validateCssColor(undefined)).toBeNull()
	})
})

describe("validateUrlScheme", () => {
	it.each([
		"https://example.com",
		"http://example.com/x",
		"mailto:hi@example.com",
		"/relative/path",
		"/page?x=1",
	])("accepts %s", (value) => {
		expect(validateUrlScheme(value)).toBe(value)
	})

	it.each([
		"javascript:alert(1)",
		"JAVASCRIPT:alert(1)",
		"data:text/html,<script>",
		"vbscript:msgbox(1)",
		"//attacker.com/",
		"file:///etc/passwd",
		"",
	])("rejects %s", (value) => {
		expect(validateUrlScheme(value)).toBeNull()
	})
})

describe("escapeJsonInHtml", () => {
	it("escapes script-terminator characters", () => {
		const escaped = escapeJsonInHtml(JSON.stringify({ msg: "</script><script>alert(1)</script>" }))
		expect(escaped).not.toContain("</script>")
		expect(escaped).toContain("\\u003c/script\\u003e")
	})
	it("escapes line terminators", () => {
		const lineSep = String.fromCharCode(0x2028)
		const paraSep = String.fromCharCode(0x2029)
		const escaped = escapeJsonInHtml(JSON.stringify({ msg: `a${lineSep}b${paraSep}c` }))
		expect(escaped).toContain("\\u2028")
		expect(escaped).toContain("\\u2029")
	})
})

describe("validateInternalRedirect", () => {
	it.each(["/", "/dashboard", "/path?x=1", "/a/b#c"])("accepts %s", (value) => {
		expect(validateInternalRedirect(value)).toBe(value)
	})

	it.each([
		"//attacker.com",
		"https://attacker.com",
		"javascript:alert(1)",
		"dashboard",
		"",
		"/\\bad",
	])("rejects %s", (value) => {
		expect(validateInternalRedirect(value)).toBeNull()
	})
})
