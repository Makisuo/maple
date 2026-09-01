import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { parseUrl, parseUrlWithBase, urlPathname } from "./url"

describe("parseUrl", () => {
	it("decodes an absolute URL", () => {
		const parsed = parseUrl("https://api.example.com/probe?x=1")
		expect(Option.isSome(parsed)).toBe(true)
		expect(Option.getOrThrow(parsed).hostname).toBe("api.example.com")
	})

	it.each(["", "   ", "not a url", "http://", "/relative/only"])(
		"is absent rather than throwing for %s",
		(raw) => {
			expect(Option.isNone(parseUrl(raw))).toBe(true)
		},
	)
})

describe("parseUrlWithBase", () => {
	it("resolves a relative target against its base", () => {
		const resolved = parseUrlWithBase("/avatar.png?size=64", "https://github.acme.internal/x/y")
		expect(Option.getOrThrow(resolved).href).toBe("https://github.acme.internal/avatar.png?size=64")
	})

	it("keeps an absolute target", () => {
		const resolved = parseUrlWithBase("https://other.example.com/z", "https://api.example.com")
		expect(Option.getOrThrow(resolved).href).toBe("https://other.example.com/z")
	})

	it("is absent when the base is not a URL", () => {
		expect(Option.isNone(parseUrlWithBase("/a", "not a url"))).toBe(true)
	})

	it("is absent when the pair does not resolve", () => {
		expect(Option.isNone(parseUrlWithBase("http://", "https://api.example.com"))).toBe(true)
	})
})

describe("urlPathname", () => {
	it("reads the path of a request URL", () => {
		expect(urlPathname("https://api.example.com/v2/traces?limit=1")).toBe("/v2/traces")
	})

	// The shape the request predicates rely on: no path matches no route, which
	// is what their `catch { return false }` blocks used to spell out.
	it("is empty for an unparseable URL", () => {
		expect(urlPathname("not a url")).toBe("")
	})
})
