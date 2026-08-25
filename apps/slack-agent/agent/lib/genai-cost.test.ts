import { describe, expect, test } from "bun:test"
import type { Attributes } from "@opentelemetry/api"
import {
	extractOpenRouterCost,
	GENAI_USAGE_COST_ATTR,
	PROVIDER_METADATA_ATTR,
	stampGenAiCost,
} from "#lib/genai-cost.js"

/** Provider metadata as eve's OTel integration serializes it onto spans. */
const metadataJson = (usage: Record<string, unknown>): string =>
	JSON.stringify({ openrouter: { provider: "openai", usage } })

describe("extractOpenRouterCost", () => {
	test("reads the charged cost", () => {
		expect(extractOpenRouterCost(metadataJson({ cost: 0.01275 }))).toBe(0.01275)
	})

	test("adds the BYOK upstream inference cost to OpenRouter's fee", () => {
		expect(
			extractOpenRouterCost(
				metadataJson({ cost: 0.0005, costDetails: { upstreamInferenceCost: 0.01 } }),
			),
		).toBeCloseTo(0.0105, 10)
	})

	test("zero cost is real accounting (free-tier model), not absence", () => {
		expect(extractOpenRouterCost(metadataJson({ cost: 0 }))).toBe(0)
	})

	test("no cost field (accounting disabled) yields undefined", () => {
		expect(extractOpenRouterCost(metadataJson({ promptTokens: 12 }))).toBeUndefined()
	})

	test("non-OpenRouter metadata yields undefined", () => {
		expect(
			extractOpenRouterCost(JSON.stringify({ anthropic: { cacheCreationInputTokens: 5 } })),
		).toBeUndefined()
	})

	test("malformed JSON and non-numeric cost yield undefined", () => {
		expect(extractOpenRouterCost("{not json")).toBeUndefined()
		expect(extractOpenRouterCost(metadataJson({ cost: "0.01" }))).toBeUndefined()
		expect(extractOpenRouterCost(metadataJson({ cost: Number.NaN }))).toBeUndefined()
	})
})

describe("stampGenAiCost", () => {
	test("stamps gen_ai.usage.cost on attributes carrying costed provider metadata", () => {
		const attributes: Attributes = {
			[PROVIDER_METADATA_ATTR]: metadataJson({ cost: 0.002 }),
		}
		stampGenAiCost(attributes)
		expect(attributes[GENAI_USAGE_COST_ATTR]).toBe(0.002)
	})

	test("leaves attributes without provider metadata or without cost untouched", () => {
		const plain: Attributes = { "gen_ai.operation.name": "chat" }
		const uncosted: Attributes = {
			[PROVIDER_METADATA_ATTR]: metadataJson({ promptTokens: 3 }),
		}
		stampGenAiCost(plain)
		stampGenAiCost(uncosted)
		expect(plain[GENAI_USAGE_COST_ATTR]).toBeUndefined()
		expect(uncosted[GENAI_USAGE_COST_ATTR]).toBeUndefined()
	})
})
