import { describe, expect, it } from "vitest"
import { genAiIntegration, mapAiSpan, mapAiSpans, resolveAiIntegration } from "./ai-integrations"
import { AI_GENAI_FIELDS, type AiGenAiField } from "@maple/domain/gen-ai"
import type { AiSessionSpansOutput } from "./ai-sessions"

const row = (
	spanAttributes: Record<string, string>,
	overrides: Partial<AiSessionSpansOutput> = {},
): AiSessionSpansOutput => ({
	traceId: "d31eaf1d98a9b26028dfe521f8dbc75c",
	spanId: "00233d43ea0d1598",
	parentSpanId: "68fc42c0c9f2cf15",
	spanName: "invoke_agent openai/gpt-5.6-luna",
	spanKind: "Internal",
	serviceName: "maple-slack-agent",
	durationMs: 2995.573199,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-12 15:18:42.207000000",
	spanAttributes,
	resourceAttributes: {},
	...overrides,
})

/** A real `invoke_agent` span from this org, canonical `gen_ai.*` throughout. */
const INVOKE_AGENT_ATTRS = {
	"ai.settings.context.eve.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
	"ai.settings.context.eve.turn.id": "turn_0",
	"gen_ai.agent.name": "slack-agent",
	"gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"hello"}]}]',
	"gen_ai.operation.name": "invoke_agent",
	"gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"hi"}]}]',
	"gen_ai.provider.name": "openrouter",
	"gen_ai.request.model": "openai/gpt-5.6-luna",
	"gen_ai.response.finish_reasons": '["stop"]',
	"gen_ai.system_instructions": '[{"type":"text","content":"You are Maple AI"}]',
	"gen_ai.usage.cache_creation.input_tokens": "106",
	"gen_ai.usage.cache_read.input_tokens": "4924",
	"gen_ai.usage.input_tokens": "5033",
	"gen_ai.usage.output_tokens": "38",
	"maple_ai.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
	"maple_ai.vendor.id": "vercel_ai_sdk",
	"maple_ai.vendor.version": "0",
}

/** A real `execute_tool` span — the tool fields, including two JSON blobs. */
const EXECUTE_TOOL_ATTRS = {
	"gen_ai.execute_tool.duration": "0.5546019470000029",
	"gen_ai.operation.name": "execute_tool",
	"gen_ai.tool.call.arguments": '{"emoji":"wave"}',
	"gen_ai.tool.call.id": "call_uKgzomwVJhP3bYZ0fxvwUe86",
	"gen_ai.tool.call.result": '{"reacted":true,"emoji":"wave"}',
	"gen_ai.tool.name": "add_reaction",
	"gen_ai.tool.type": "function",
}

/**
 * A real `workflow.stream.flush` span. Every key is present with an empty value
 * because ClickHouse returns `''` for a missing `Map` key — the exact shape that
 * would look like "present" to a naive reader.
 */
const NON_AI_ATTRS = {
	"cache.name": "",
	"db.system": "",
	"http.request.method": "",
	"http.response.status_code": "",
	"server.address": "",
	"url.full": "",
}

const SAMPLE_ATTRIBUTE_VALUE = {
	string: "sample",
	number: "42",
	boolean: "true",
	stringArray: '["a"]',
	json: '{"a":1}',
} as const

const SAMPLE_DECODED_VALUE = {
	string: "sample",
	number: 42,
	boolean: true,
	stringArray: ["a"],
	json: { a: 1 },
} as const

describe("the catalog is the contract", () => {
	// Driven from `AI_GENAI_FIELDS` itself rather than a hand-written list, so a
	// field added to the catalog without a source mapping fails here instead of
	// silently returning `undefined` in the UI forever.
	for (const [field, def] of Object.entries(AI_GENAI_FIELDS)) {
		it(`maps the canonical key ${def.key} to ${field}`, () => {
			const mapped = mapAiSpan(row({ [def.key]: SAMPLE_ATTRIBUTE_VALUE[def.type] }))

			expect(mapped.genAi[field as AiGenAiField]).toEqual(SAMPLE_DECODED_VALUE[def.type])
		})
	}

	it("declares a source list for every catalog field", () => {
		expect(Object.keys(genAiIntegration.sources).sort()).toEqual(Object.keys(AI_GENAI_FIELDS).sort())
	})
})

describe("value decoding", () => {
	it("decodes numbers out of the Map(String, String) wire format", () => {
		const mapped = mapAiSpan(row(INVOKE_AGENT_ATTRS))

		expect(mapped.genAi.usageInputTokens).toBe(5033)
		expect(mapped.genAi.usageCacheReadInputTokens).toBe(4924)
	})

	it("rejects a number that is not finite instead of poisoning arithmetic", () => {
		// A dashboard that sums NaN token counts shows NaN for the whole session,
		// which is strictly worse than showing nothing for one span.
		expect(
			mapAiSpan(row({ "gen_ai.usage.input_tokens": "not-a-number" })).genAi.usageInputTokens,
		).toBeUndefined()
		expect(
			mapAiSpan(row({ "gen_ai.usage.input_tokens": "Infinity" })).genAi.usageInputTokens,
		).toBeUndefined()
	})

	it("accepts both the word and the digit form of a boolean", () => {
		expect(mapAiSpan(row({ "gen_ai.request.stream": "true" })).genAi.requestStream).toBe(true)
		expect(mapAiSpan(row({ "gen_ai.request.stream": "1" })).genAi.requestStream).toBe(true)
		expect(mapAiSpan(row({ "gen_ai.request.stream": "false" })).genAi.requestStream).toBe(false)
		expect(mapAiSpan(row({ "gen_ai.request.stream": "0" })).genAi.requestStream).toBe(false)
		expect(mapAiSpan(row({ "gen_ai.request.stream": "yes" })).genAi.requestStream).toBeUndefined()
	})

	it("accepts both shapes real instrumentation emits for a string array", () => {
		// Production carries both for `gen_ai.response.finish_reasons`: the
		// serialised array and the bare single value.
		expect(
			mapAiSpan(row({ "gen_ai.response.finish_reasons": '["stop"]' })).genAi.responseFinishReasons,
		).toEqual(["stop"])
		expect(
			mapAiSpan(row({ "gen_ai.response.finish_reasons": "stop" })).genAi.responseFinishReasons,
		).toEqual(["stop"])
	})

	it("decodes JSON blobs into structured values", () => {
		const mapped = mapAiSpan(row(EXECUTE_TOOL_ATTRS))

		expect(mapped.genAi.toolCallArguments).toEqual({ emoji: "wave" })
		expect(mapped.genAi.toolCallResult).toEqual({ reacted: true, emoji: "wave" })
		expect(mapped.genAi.toolName).toBe("add_reaction")
		expect(mapped.genAi.toolCallId).toBe("call_uKgzomwVJhP3bYZ0fxvwUe86")
	})

	it("yields no field for malformed JSON rather than throwing", () => {
		// One truncated attribute must not cost the caller the rest of the span.
		const mapped = mapAiSpan(
			row({ "gen_ai.tool.call.arguments": '{"emoji":', "gen_ai.tool.name": "add_reaction" }),
		)

		expect(mapped.genAi.toolCallArguments).toBeUndefined()
		expect(mapped.genAi.toolName).toBe("add_reaction")
	})

	it("treats an empty or blank value as absent, because that is what a missing Map key returns", () => {
		expect(mapAiSpan(row({ "gen_ai.request.model": "" })).genAi.requestModel).toBeUndefined()
		expect(mapAiSpan(row({ "gen_ai.request.model": "   " })).genAi.requestModel).toBeUndefined()
	})

	it("keeps only objects and arrays for a JSON field", () => {
		// `"null"`, `"0"` and `"false"` all parse cleanly into values that would
		// reach the UI where a message list belongs.
		expect(mapAiSpan(row({ "gen_ai.input.messages": "null" })).genAi.inputMessages).toBeUndefined()
		expect(mapAiSpan(row({ "gen_ai.input.messages": "0" })).genAi.inputMessages).toBeUndefined()
		expect(mapAiSpan(row({ "gen_ai.input.messages": "false" })).genAi.inputMessages).toBeUndefined()
	})

	it("falls through to the next alias when the first key does not decode", () => {
		const mapped = mapAiSpan(
			row({ "gen_ai.usage.input_tokens": "n/a", "gen_ai.usage.prompt_tokens": "5033" }),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
	})
})

describe("legacy aliases", () => {
	// One case per row of the semconv deprecation table.
	const cases: ReadonlyArray<readonly [string, string, AiGenAiField, unknown]> = [
		["gen_ai.usage.prompt_tokens", "5033", "usageInputTokens", 5033],
		["gen_ai.usage.completion_tokens", "38", "usageOutputTokens", 38],
		["gen_ai.prompt", '[{"role":"user"}]', "inputMessages", [{ role: "user" }]],
		["gen_ai.completion", '[{"role":"assistant"}]', "outputMessages", [{ role: "assistant" }]],
		["gen_ai.system", "anthropic", "providerName", "anthropic"],
		["gen_ai.openai.request.seed", "7", "requestSeed", 7],
		["gen_ai.response.finish_reason", "stop", "responseFinishReasons", ["stop"]],
		// Not in the deprecation table: the sub-key spelling OpenRouter actually
		// emits. Both confirmed present in the warehouse — unlike the plausible
		// `gen_ai.usage.reasoning_tokens`, which is not, and so is not mapped.
		["gen_ai.usage.output_tokens.reasoning", "704", "usageReasoningOutputTokens", 704],
		["gen_ai.usage.input_tokens.cached", "2048", "usageCacheReadInputTokens", 2048],
		// The registry spelling, not a deprecation: semconv says `cache_write`
		// where the catalog's primary keeps the Anthropic-era `cache_creation`.
		["gen_ai.usage.cache_write.input_tokens", "512", "usageCacheCreationInputTokens", 512],
	]

	for (const [key, value, field, expected] of cases) {
		it(`reads the deprecated ${key} into ${field}`, () => {
			expect(mapAiSpan(row({ [key]: value })).genAi[field]).toEqual(expected)
		})
	}

	it("prefers the canonical key when both are present", () => {
		const mapped = mapAiSpan(
			row({ "gen_ai.usage.input_tokens": "5033", "gen_ai.usage.prompt_tokens": "1" }),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
	})

	it("maps a real legacy OpenRouter span through the aliases alone", () => {
		// The dialect an OpenRouter/traceloop-style instrumentor still emits:
		// prompt/completion/system, and the singular finish reason.
		const mapped = mapAiSpan(
			row({
				"gen_ai.system": "openai",
				"gen_ai.prompt": '[{"role":"user","content":"hi"}]',
				"gen_ai.completion": '[{"role":"assistant","content":"hello"}]',
				"gen_ai.response.finish_reason": "stop",
				"gen_ai.usage.prompt_tokens": "12",
				"gen_ai.usage.completion_tokens": "4",
			}),
		)

		expect(mapped.genAi).toEqual({
			providerName: "openai",
			inputMessages: [{ role: "user", content: "hi" }],
			outputMessages: [{ role: "assistant", content: "hello" }],
			responseFinishReasons: ["stop"],
			usageInputTokens: 12,
			usageOutputTokens: 4,
		})
		expect(mapped.isAiSpan).toBe(true)
	})
})

describe("value normalisation", () => {
	// The `gen_ai.system` enum members that were renamed with the attribute.
	const renames: ReadonlyArray<readonly [string, string]> = [
		["vertex_ai", "gcp.vertex_ai"],
		["gemini", "gcp.gemini"],
		["az.ai.inference", "azure.ai.inference"],
		["az.ai.openai", "azure.ai.openai"],
		["xai", "x_ai"],
	]

	for (const [legacy, canonical] of renames) {
		it(`rewrites the legacy provider value ${legacy}`, () => {
			expect(mapAiSpan(row({ "gen_ai.system": legacy })).genAi.providerName).toBe(canonical)
		})
	}

	it("leaves a legacy value alone when it survived the rename", () => {
		expect(mapAiSpan(row({ "gen_ai.system": "anthropic" })).genAi.providerName).toBe("anthropic")
	})

	it("never rewrites a value that arrived on the canonical key", () => {
		// A span emitting `gen_ai.provider.name` already speaks the new
		// vocabulary; a collision with an old enum member is its value to keep.
		const mapped = mapAiSpan(row({ "gen_ai.provider.name": "gemini", "gen_ai.system": "vertex_ai" }))

		expect(mapped.genAi.providerName).toBe("gemini")
	})

	it("singularises the old tool_calls finish reason", () => {
		const mapped = mapAiSpan(row({ "gen_ai.response.finish_reasons": '["tool_calls","stop"]' }))

		expect(mapped.genAi.responseFinishReasons).toEqual(["tool_call", "stop"])
	})
})

describe("prompt variables", () => {
	it("counts a templated gen_ai.prompt.variable.<name> attribute as AI signal", () => {
		// Templated: the variable name is IN the key, so there is no single key
		// the source-list mechanism could look up. The values are not on the wire
		// — their presence is what marks the span.
		const mapped = mapAiSpan(row({ "gen_ai.prompt.variable.service": "maple-api" }))

		expect(mapped.isAiSpan).toBe(true)
		expect(mapped.genAi).toEqual({})
	})
})

describe("non-AI spans", () => {
	it("maps an ordinary infrastructure span to a clean not-an-AI-span result", () => {
		const mapped = mapAiSpan(row(NON_AI_ATTRS, { spanName: "workflow.stream.flush", spanKind: "Client" }))

		expect(mapped.isAiSpan).toBe(false)
		expect(mapped.genAi).toEqual({})
		expect(mapped.vendorId).toBeUndefined()
	})

	it("does not treat a core semconv attribute as AI signal", () => {
		// `server.address` is on every HTTP client span in the trace. It is worth
		// surfacing next to the AI fields, but it cannot be what decides that a
		// span is an AI span.
		const mapped = mapAiSpan(row({ "server.address": "openrouter.ai", "server.port": "443" }))

		expect(mapped.genAi.serverAddress).toBe("openrouter.ai")
		expect(mapped.isAiSpan).toBe(false)
	})

	it("counts the gateway stamp alone as AI signal", () => {
		// The gateway saw evidence the read path cannot (scope, resource SDK
		// name, span events), so its stamp outranks the absence of gen_ai keys.
		const mapped = mapAiSpan(row({ "maple_ai.vendor.id": "eve", "maple_ai.vendor.version": "0" }))

		expect(mapped.isAiSpan).toBe(true)
	})
})

describe("span envelope", () => {
	it("carries the warehouse columns and the gateway stamp through untouched", () => {
		const mapped = mapAiSpan(row(INVOKE_AGENT_ATTRS))

		expect(mapped).toMatchObject({
			traceId: "d31eaf1d98a9b26028dfe521f8dbc75c",
			spanId: "00233d43ea0d1598",
			parentSpanId: "68fc42c0c9f2cf15",
			spanName: "invoke_agent openai/gpt-5.6-luna",
			spanKind: "Internal",
			serviceName: "maple-slack-agent",
			timestamp: "2026-08-12 15:18:42.207000000",
			durationMs: 2995.573199,
			statusCode: "Unset",
			statusMessage: "",
			sessionId: "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
			vendorId: "vercel_ai_sdk",
			vendorVersion: "0",
			isAiSpan: true,
		})
	})

	it("reads gen_ai keys from span attributes alone", () => {
		// A resource-level `gen_ai.*` key describes the process, not the
		// operation: honouring it would stamp every span of that service —
		// Postgres, HTTP, everything — as an AI span.
		const mapped = mapAiSpan(
			row({}, { resourceAttributes: { "gen_ai.request.model": "resource-level" } }),
		)

		expect(mapped.genAi.requestModel).toBeUndefined()
		expect(mapped.isAiSpan).toBe(false)
	})

	it("maps a whole trace's worth of spans in order", () => {
		const mapped = mapAiSpans([
			row(INVOKE_AGENT_ATTRS),
			row(NON_AI_ATTRS, { spanName: "workflow.stream.flush" }),
		])

		expect(mapped.map((span) => span.isAiSpan)).toEqual([true, false])
	})
})

describe("resolveAiIntegration", () => {
	it("falls back to the default integration for a vendor with no override", () => {
		// `unknown:other` is a real gateway stamp: AI-shaped span, no recognised
		// framework. It must map through the default, not fail.
		const integration = resolveAiIntegration("unknown:other")

		expect(integration).toBe(genAiIntegration)
		expect(
			mapAiSpan(row({ ...INVOKE_AGENT_ATTRS, "maple_ai.vendor.id": "unknown:other" })).isAiSpan,
		).toBe(true)
	})

	it("falls back to the default integration for an unstamped span", () => {
		expect(resolveAiIntegration(undefined)).toBe(genAiIntegration)
	})

	it("returns the same merged integration on every call for a vendor", () => {
		// The merge runs once at module init; re-merging sixty source lists on
		// every span of every session is pure waste.
		expect(resolveAiIntegration("vercel_ai_sdk")).toBe(resolveAiIntegration("vercel_ai_sdk"))
	})
})

describe("untrusted attribute keys", () => {
	it("ignores a vendor stamp that arrives via a resource attribute", () => {
		// The envelope is read from span attributes alone, so a resource-level
		// stamp neither selects an integration nor marks the span.
		const mapped = mapAiSpan(row({}, { resourceAttributes: { "maple_ai.vendor.id": "eve" } }))

		expect(mapped.vendorId).toBeUndefined()
		expect(mapped.isAiSpan).toBe(false)
	})

	it("keeps a prompt variable literally named __proto__ as AI signal", () => {
		expect(mapAiSpan(row({ "gen_ai.prompt.variable.__proto__": "kept" })).isAiSpan).toBe(true)
	})
})

describe("stringArray decoding rejects malformed arrays", () => {
	it("treats a bare value as the single-element form", () => {
		expect(
			mapAiSpan(row({ "gen_ai.response.finish_reasons": "stop" })).genAi.responseFinishReasons,
		).toEqual(["stop"])
	})

	it("yields no field for an array of non-strings rather than wrapping the raw JSON", () => {
		const mapped = mapAiSpan(row({ "gen_ai.response.finish_reasons": "[1,2]" }))

		// Wrapping to `['[1,2]']` would type-check and silently consume the field
		// with a value that never existed.
		expect(mapped.genAi.responseFinishReasons).toBeUndefined()
	})

	it("lets the next alias win when the canonical key is malformed", () => {
		const mapped = mapAiSpan(
			row({
				"gen_ai.response.finish_reasons": '{"reason":"stop"}',
				"gen_ai.response.finish_reason": "length",
			}),
		)

		expect(mapped.genAi.responseFinishReasons).toEqual(["length"])
	})
})
