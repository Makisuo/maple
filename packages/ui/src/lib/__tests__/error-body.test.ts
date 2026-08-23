import { describe, expect, it } from "vitest"

import { parseErrorBody, splitErrorText, tokenizeJson } from "../error-body"

describe("parseErrorBody", () => {
	it("pretty-prints JSON objects", () => {
		const body = parseErrorBody('{"code":500,"message":"boom"}')
		expect(body.format).toBe("json")
		expect(body.full).toBe('{\n  "code": 500,\n  "message": "boom"\n}')
	})

	it("treats malformed and scalar JSON as text", () => {
		expect(parseErrorBody('{"code":500').format).toBe("text")
		expect(parseErrorBody('"just a string"').format).toBe("text")
	})

	it("leaves plain text — and its line breaks — untouched", () => {
		const body = parseErrorBody("Timed out\n  at fetch()")
		expect(body.format).toBe("text")
		expect(body.full).toBe("Timed out\n  at fetch()")
	})
})

describe("tokenizeJson", () => {
	it("distinguishes keys from string values", () => {
		const tokens = tokenizeJson('{"message": "boom"}')
		expect(tokens.filter((t) => t.type === "key").map((t) => t.text)).toEqual(['"message"'])
		expect(tokens.filter((t) => t.type === "string").map((t) => t.text)).toEqual(['"boom"'])
	})

	it("tags numbers and literals, and round-trips the source", () => {
		const source = '{\n  "retries": -1.5e3,\n  "ok": false,\n  "cause": null\n}'
		const tokens = tokenizeJson(source)
		expect(tokens.map((t) => t.text).join("")).toBe(source)
		expect(tokens.filter((t) => t.type === "number").map((t) => t.text)).toEqual(["-1.5e3"])
		expect(tokens.filter((t) => t.type === "keyword").map((t) => t.text)).toEqual(["false", "null"])
	})

	it("does not mistake a colon inside a string for a key separator", () => {
		const tokens = tokenizeJson('{"url": "https://x.dev"}')
		expect(tokens.filter((t) => t.type === "key").map((t) => t.text)).toEqual(['"url"'])
	})
})

describe("splitErrorText", () => {
	it("marks stack frames after the first line", () => {
		const lines = splitErrorText("Cannot read x\n    at handler (a.ts:1)\n    at run (b.ts:2)")
		expect(lines.map((l) => l.frame)).toEqual([false, true, true])
	})

	it("keeps a multi-line message unframed", () => {
		expect(splitErrorText("line one\nline two").map((l) => l.frame)).toEqual([false, false])
	})
})
