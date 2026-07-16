import { describe, expect, it } from "vitest"

import { tokenizeWhereClause } from "./where-clause-highlight"

describe("tokenizeWhereClause", () => {
	it("round-trips the input text", () => {
		const input = 'service.name = "checkout" AND attr.http.route != "/health"'
		const tokens = tokenizeWhereClause(input)
		expect(tokens.map((token) => token.text).join("")).toBe(input)
	})

	it("classifies keys, operators, strings, and AND", () => {
		const tokens = tokenizeWhereClause('service.name = "checkout" AND duration > 100')
		expect(tokens).toEqual([
			{ text: "service.name", type: "key" },
			{ text: " ", type: "plain" },
			{ text: "=", type: "operator" },
			{ text: " ", type: "plain" },
			{ text: '"checkout"', type: "string" },
			{ text: " ", type: "plain" },
			{ text: "AND", type: "keyword" },
			{ text: " ", type: "plain" },
			{ text: "duration", type: "key" },
			{ text: " ", type: "plain" },
			{ text: ">", type: "operator" },
			{ text: " ", type: "plain" },
			{ text: "100", type: "number" },
		])
	})

	it("treats word operators and negations as operators", () => {
		const tokens = tokenizeWhereClause("span.name contains checkout AND attr.foo !exists")
		expect(tokens.find((token) => token.text === "contains")?.type).toBe("operator")
		expect(tokens.find((token) => token.text === "!exists")?.type).toBe("operator")
	})

	it("highlights bare words after an operator as values, not keys", () => {
		const tokens = tokenizeWhereClause("service.name = checkout")
		expect(tokens.find((token) => token.text === "checkout")?.type).toBe("value")
	})

	it("does not treat dotted keys containing operator words as operators", () => {
		const tokens = tokenizeWhereClause("attr.contains = true")
		expect(tokens[0]).toEqual({ text: "attr.contains", type: "key" })
		expect(tokens.find((token) => token.text === "true")?.type).toBe("boolean")
	})

	it("handles unterminated quotes without dropping text", () => {
		const input = 'service.name = "check'
		const tokens = tokenizeWhereClause(input)
		expect(tokens.map((token) => token.text).join("")).toBe(input)
		expect(tokens[tokens.length - 1]).toEqual({ text: '"check', type: "string" })
	})

	it("is case-insensitive for AND", () => {
		const tokens = tokenizeWhereClause("a = 1 and b = 2")
		expect(tokens.find((token) => token.text === "and")?.type).toBe("keyword")
	})
})
