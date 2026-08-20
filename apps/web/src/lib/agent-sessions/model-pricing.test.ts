import { describe, expect, it } from "vitest"

import { computeModelSpend, lookupModelPrice, PRICE_TABLE_DATE } from "./model-pricing"

const noTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }

// The arithmetic is what these assert; the rates come from the table so a price
// revision does not read as a broken sum.
const SONNET = lookupModelPrice("claude-sonnet-4-5")!
const HAIKU = lookupModelPrice("claude-haiku-4-5")!

describe("lookupModelPrice", () => {
	it("prices a dated release id off its family", () => {
		expect(lookupModelPrice("claude-sonnet-4-5-20250929")).toEqual(lookupModelPrice("claude-sonnet-4-5"))
	})

	it("prefers the longest matching prefix", () => {
		// Two rows either of which the id starts with, at very different prices.
		expect(lookupModelPrice("gpt-5-mini-2025-08-07")?.input).toBe(0.25)
		expect(lookupModelPrice("gpt-5")?.input).toBe(1.25)
	})

	it("ignores a gateway's routing prefix and the model's casing", () => {
		expect(lookupModelPrice("anthropic/Claude-Opus-4-1")).toEqual(lookupModelPrice("claude-opus-4-1"))
		expect(lookupModelPrice("models/gemini-2.5-pro")).toEqual(lookupModelPrice("gemini-2.5-pro"))
	})

	it("has no answer for a model it does not list", () => {
		expect(lookupModelPrice("some-internal-model")).toBeUndefined()
	})

	it("will not price a model off a neighbouring row", () => {
		// Each of these starts with a row that is not its family: a bare prefix
		// match would read gpt-4o's price for the mini (16.7x too high), o3's for
		// o3-pro (10x too low), and gpt-5's for whatever ships next.
		expect(lookupModelPrice("gpt-4o-mini")).not.toEqual(lookupModelPrice("gpt-4o"))
		expect(lookupModelPrice("o3-pro")).not.toEqual(lookupModelPrice("o3"))
		expect(lookupModelPrice("gpt-5.6-luna")).toBeUndefined()
		expect(lookupModelPrice("o3-deep-research")).toBeUndefined()
	})

	it("carries a date to show beside the estimate", () => {
		expect(PRICE_TABLE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})
})

describe("computeModelSpend", () => {
	it("prices each bucket at its own rate", () => {
		const { totalUsd } = computeModelSpend([
			{
				model: "claude-sonnet-4-5",
				// 1M input, 1M cache read, 1M cache write, 1M output.
				tokens: { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6, reasoning: 0 },
			},
		])

		expect(totalUsd).toBeCloseTo(SONNET.input + SONNET.cacheRead + SONNET.cacheWrite + SONNET.output, 6)
	})

	it("bills reasoning tokens as output", () => {
		const reasoningOnly = computeModelSpend([
			{ model: "claude-sonnet-4-5", tokens: { ...noTokens, reasoning: 1e6 } },
		])
		const outputOnly = computeModelSpend([
			{ model: "claude-sonnet-4-5", tokens: { ...noTokens, output: 1e6 } },
		])

		expect(reasoningOnly.totalUsd).toBe(outputOnly.totalUsd)
	})

	it("adds up across models", () => {
		const { totalUsd, unpricedModels } = computeModelSpend([
			{ model: "claude-sonnet-4-5", tokens: { ...noTokens, output: 1e6 } },
			{ model: "claude-haiku-4-5", tokens: { ...noTokens, output: 1e6 } },
		])

		expect(totalUsd).toBeCloseTo(SONNET.output + HAIKU.output, 6)
		expect(unpricedModels).toEqual([])
	})

	it("names the models it could not price instead of guessing at them", () => {
		const { totalUsd, unpricedModels } = computeModelSpend([
			{ model: "claude-sonnet-4-5", tokens: { ...noTokens, output: 1e6 } },
			{ model: "an-unreleased-model", tokens: { ...noTokens, input: 5000, output: 500 } },
		])

		expect(totalUsd).toBeCloseTo(SONNET.output, 6)
		expect(unpricedModels).toEqual(["an-unreleased-model"])
	})

	it("does not flag an unpriced model that spent nothing", () => {
		const { unpricedModels } = computeModelSpend([{ model: "an-unreleased-model", tokens: noTokens }])

		expect(unpricedModels).toEqual([])
	})

	it("is zero for a session with no usage at all", () => {
		expect(computeModelSpend([])).toEqual({ totalUsd: 0, unpricedModels: [] })
	})
})
