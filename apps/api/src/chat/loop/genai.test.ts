/**
 * The attribute builders' one non-negotiable contract: whatever the size
 * pressure, `gen_ai.input.messages` stays an array and the tool payloads stay
 * objects — the read side's `json` decoder drops anything else, so a degraded
 * shape does not render truncated, it vanishes.
 */
import { MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR } from "@maple/domain/gen-ai"
import { LLMResponse, Message, SystemPart, ToolResultPart, Usage, type Model } from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { assert, describe, it } from "vitest"
import {
	modelCallAttributes,
	modelResponseAttributes,
	semconvFinishReason,
	toolCallJson,
} from "./genai"

const MODEL: Model = CloudflareWorkersAI.configure({ accountId: "t", apiKey: "t" }).model("@cf/test/model")

const IDENTITY = { sessionId: "org_1:tab-1", turnId: "msg_1" }

const INPUT_MESSAGES_BUDGET = 20_000
const TOOL_JSON_BUDGET = 8_000

const inputMessages = (messages: ReadonlyArray<Message>) => {
	const attributes = modelCallAttributes(MODEL, messages, IDENTITY)
	const json = attributes["gen_ai.input.messages"] as string
	return { attributes, json, parsed: JSON.parse(json) as unknown }
}

describe("modelCallAttributes input messages", () => {
	it("keeps a small transcript intact as a decodable message array", () => {
		const { attributes, parsed } = inputMessages([Message.user("hello"), Message.assistant("hi")])

		assert.deepEqual(parsed, [
			{ role: "user", parts: [{ type: "text", content: "hello" }] },
			{ role: "assistant", parts: [{ type: "text", content: "hi" }] },
		])
		assert.notProperty(attributes, MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR)
	})

	it("drops whole oldest messages first and reports the count", () => {
		const filler = "x".repeat(2_000)
		const messages = Array.from({ length: 20 }, (_, i) => Message.user(`${i}:${filler}`))
		const { attributes, json, parsed } = inputMessages(messages)

		assert.isAtMost(json.length, INPUT_MESSAGES_BUDGET)
		assert.isArray(parsed)
		const kept = parsed as Array<{ parts: Array<{ content: string }> }>
		const dropped = attributes[MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR] as number
		assert.equal(dropped, messages.length - kept.length)
		assert.isAbove(dropped, 0)
		// The newest message survives whole, not truncated.
		assert.equal(kept.at(-1)!.parts[0]!.content, `19:${filler}`)
	})

	it("bounds an oversized message's payloads instead of degrading the array to a string", () => {
		// A 50k tool result against the 20k budget — the routine case, since
		// MAX_TOOL_OUTPUT_BYTES upstream is 50k. The old fallback re-encoded the
		// whole value as a JSON string, which the read side then dropped.
		const messages = [
			Message.user("run the query"),
			Message.tool(ToolResultPart.make({ id: "t1", name: "query_data", result: "y".repeat(50_000) })),
		]
		const { attributes, json, parsed } = inputMessages(messages)

		assert.isArray(parsed)
		const kept = parsed as Array<{ parts: Array<{ type: string; result?: string }> }>
		const result = kept.at(-1)!.parts[0]!.result!
		assert.include(result, "…[truncated]")
		assert.isAtMost(json.length, INPUT_MESSAGES_BUDGET)
		// Once the oversized message is bounded there is room again for the older
		// one, so nothing is dropped — the whole exchange stays visible.
		assert.lengthOf(kept, 2)
		assert.notProperty(attributes, MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR)
	})
})

describe("toolCallJson", () => {
	it("wraps a string result so the attribute decodes as an object", () => {
		assert.deepEqual(JSON.parse(toolCallJson("42 traces")), { result: "42 traces" })
	})

	it("passes objects and arrays through unwrapped", () => {
		assert.deepEqual(JSON.parse(toolCallJson({ rows: [1, 2] })), { rows: [1, 2] })
		assert.deepEqual(JSON.parse(toolCallJson([1, 2])), [1, 2])
	})

	it("truncates an oversized value into a bounded object, still valid JSON", () => {
		const out = toolCallJson("z".repeat(50_000))
		assert.isAtMost(out.length, TOOL_JSON_BUDGET)
		// SAFETY: the truncation branch under test emits exactly this shape; the
		// assertions below fail loudly if it ever does not.
		const parsed = JSON.parse(out) as { truncated: boolean; prefix: string }
		assert.isTrue(parsed.truncated)
		assert.isAbove(parsed.prefix.length, 0)
	})

	it("holds the cap even when escaping doubles the re-encoded prefix", () => {
		const out = toolCallJson('"'.repeat(50_000))
		assert.isAtMost(out.length, TOOL_JSON_BUDGET)
		assert.isObject(JSON.parse(out))
	})

	it("survives a value JSON.stringify rejects", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		assert.isObject(JSON.parse(toolCallJson(cyclic)))
	})
})

describe("modelCallAttributes system instructions", () => {
	it("emits the system prompt as a decodable part array", () => {
		const attributes = modelCallAttributes(MODEL, [], IDENTITY, SystemPart.content("You are Maple."))

		assert.deepEqual(JSON.parse(attributes["gen_ai.system_instructions"] as string), [
			{ type: "text", content: "You are Maple." },
		])
	})

	it("omits the attribute when the request has no system prompt", () => {
		assert.notProperty(modelCallAttributes(MODEL, [], IDENTITY, []), "gen_ai.system_instructions")
		assert.notProperty(modelCallAttributes(MODEL, [], IDENTITY), "gen_ai.system_instructions")
	})

	it("bounds an oversized system prompt while keeping the array shape", () => {
		const attributes = modelCallAttributes(MODEL, [], IDENTITY, SystemPart.content("s".repeat(50_000)))
		const json = attributes["gen_ai.system_instructions"] as string

		assert.isBelow(json.length, 10_000)
		// SAFETY: the builder under test emits exactly this part shape; the array
		// and content assertions below fail loudly if it ever does not.
		const parsed = JSON.parse(json) as Array<{ content: string }>
		assert.isArray(parsed)
		assert.include(parsed[0]!.content, "…[truncated]")
	})
})

describe("modelResponseAttributes", () => {
	const response = (usage: Usage | undefined, finishReason = "stop" as const) =>
		new LLMResponse({ message: Message.assistant("hi"), events: [], usage, finishReason })

	it("emits the cost OpenRouter's usage accounting reported", () => {
		const attributes = modelResponseAttributes(
			response(new Usage({ inputTokens: 100, providerMetadata: { openai: { cost: 0.0042 } } })),
		)

		assert.equal(attributes["gen_ai.usage.cost"], 0.0042)
		assert.equal(attributes["gen_ai.usage.input_tokens"], 100)
	})

	it("emits no cost when the provider reported none", () => {
		assert.notProperty(
			modelResponseAttributes(response(new Usage({ inputTokens: 100 }))),
			"gen_ai.usage.cost",
		)
		assert.notProperty(modelResponseAttributes(response(undefined)), "gen_ai.usage.cost")
	})

	it("emits cache writes under the semconv cache_write key", () => {
		const attributes = modelResponseAttributes(response(new Usage({ cacheWriteInputTokens: 512 })))

		assert.equal(attributes["gen_ai.usage.cache_write.input_tokens"], 512)
		assert.notProperty(attributes, "gen_ai.usage.cache_creation.input_tokens")
	})
})

describe("semconvFinishReason", () => {
	it("maps @maple/llm's hyphenated vocabulary to the semconv underscores", () => {
		assert.equal(semconvFinishReason("tool-calls"), "tool_calls")
		assert.equal(semconvFinishReason("content-filter"), "content_filter")
		assert.equal(semconvFinishReason("stop"), "stop")
	})
})
