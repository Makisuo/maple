import { describe, expect, it } from "vitest"

import { splitOnMatches } from "./highlighted-text"

const matched = (text: string, query: string) =>
	splitOnMatches(text, query)
		.filter((segment) => segment.match)
		.map((segment) => segment.text)

describe("splitOnMatches", () => {
	it("leaves the text whole when there is no query", () => {
		expect(splitOnMatches("timeout on /checkout", "")).toEqual([
			{ text: "timeout on /checkout", match: false },
		])
	})

	it("matches case-insensitively, anywhere in the line", () => {
		expect(splitOnMatches("Request TIMEOUT", "timeout")).toEqual([
			{ text: "Request ", match: false },
			{ text: "TIMEOUT", match: true },
		])
	})

	it("keeps the original casing of every match", () => {
		expect(matched("Timeout, then timeout", "TIMEOUT")).toEqual(["Timeout", "timeout"])
	})

	// The backend requires the whole query as one substring, so a query whose
	// words are all present but not adjacent must not look like a match.
	it("does not match the query's words separately", () => {
		expect(matched("connect failed after retry", "failed retry")).toEqual([])
	})

	it("reassembles to the original text", () => {
		const text = "a-a-a-a"
		expect(
			splitOnMatches(text, "a")
				.map((segment) => segment.text)
				.join(""),
		).toBe(text)
	})

	it("stops highlighting past the per-line cap", () => {
		expect(matched("x".repeat(200), "x")).toHaveLength(40)
	})
})
