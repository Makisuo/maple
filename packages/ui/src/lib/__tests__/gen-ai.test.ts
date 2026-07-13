import { describe, expect, it } from "vitest"

import { getCloudPlatform } from "../cloud-platforms"
import { formatGenAiCost, formatTokens, getGenAiInfo } from "../gen-ai"

// A realistic OpenRouter Broadcast span. Every value is a string because the
// ingest encoder stringifies non-string OTLP attribute values.
const OPENROUTER_SPAN: Record<string, string> = {
	"gen_ai.operation.name": "chat",
	"gen_ai.provider.name": "openai",
	"gen_ai.request.model": "openai/gpt-4o",
	"gen_ai.response.model": "gpt-4o-2024-08-06",
	"gen_ai.usage.input_tokens": "1234",
	"gen_ai.usage.output_tokens": "567",
	"gen_ai.usage.cost": "0.0091",
	"gen_ai.request.temperature": "0.7",
	"gen_ai.request.top_p": "1",
	"gen_ai.request.max_tokens": "2048",
	"gen_ai.response.finish_reasons": '["stop"]',
}

describe("getGenAiInfo", () => {
	it("normalizes a full OpenRouter span", () => {
		const info = getGenAiInfo(OPENROUTER_SPAN)
		expect(info).not.toBeNull()
		expect(info!.operation).toBe("chat")
		expect(info!.provider).toBe("openai")
		expect(info!.requestModel).toBe("openai/gpt-4o")
		expect(info!.responseModel).toBe("gpt-4o-2024-08-06")
		// Display model prefers the model that actually served the request.
		expect(info!.model).toBe("gpt-4o-2024-08-06")
		expect(info!.inputTokens).toBe(1234)
		expect(info!.outputTokens).toBe(567)
		expect(info!.totalTokens).toBe(1801)
		expect(info!.cost).toBeCloseTo(0.0091)
		expect(info!.temperature).toBe(0.7)
		expect(info!.topP).toBe(1)
		expect(info!.maxTokens).toBe(2048)
		expect(info!.finishReasons).toEqual(["stop"])
	})

	it("coalesces the legacy gen_ai.system spelling into provider", () => {
		const info = getGenAiInfo({ "gen_ai.operation.name": "chat", "gen_ai.system": "anthropic" })
		expect(info?.provider).toBe("anthropic")
	})

	it("rejects a span whose gen_ai keys are all empty (projection footgun)", () => {
		// The trimmed tree projection emits requested keys with empty-string values
		// on EVERY span — detection must key on a real value, never key presence.
		const info = getGenAiInfo({
			"gen_ai.operation.name": "",
			"gen_ai.request.model": "",
			"gen_ai.response.model": "",
			"gen_ai.usage.cost": "",
		})
		expect(info).toBeNull()
	})

	it("returns null for a non-LLM span", () => {
		expect(getGenAiInfo({ "http.request.method": "GET" })).toBeNull()
	})

	it("degrades cleanly under OpenRouter Privacy Mode (no prompt/completion/finish reasons)", () => {
		const { "gen_ai.response.finish_reasons": _omit, ...privacy } = OPENROUTER_SPAN
		const info = getGenAiInfo(privacy)
		expect(info).not.toBeNull()
		expect(info!.finishReasons).toEqual([])
		// Token/cost/model data still present.
		expect(info!.inputTokens).toBe(1234)
		expect(info!.cost).toBeCloseTo(0.0091)
		expect(info!.model).toBe("gpt-4o-2024-08-06")
	})

	it("parses finish reasons from a JSON array, a CSV string, and a bare value", () => {
		const json = getGenAiInfo({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.finish_reasons": '["stop","length"]',
		})
		expect(json?.finishReasons).toEqual(["stop", "length"])

		const csv = getGenAiInfo({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.finish_reasons": "stop, length",
		})
		expect(csv?.finishReasons).toEqual(["stop", "length"])

		const bare = getGenAiInfo({
			"gen_ai.operation.name": "chat",
			"gen_ai.response.finish_reasons": "stop",
		})
		expect(bare?.finishReasons).toEqual(["stop"])
	})

	it("falls back to total_tokens and legacy token keys", () => {
		const total = getGenAiInfo({
			"gen_ai.operation.name": "chat",
			"gen_ai.usage.total_tokens": "900",
		})
		expect(total?.totalTokens).toBe(900)

		const legacy = getGenAiInfo({
			"gen_ai.operation.name": "chat",
			"gen_ai.usage.prompt_tokens": "100",
			"gen_ai.usage.completion_tokens": "50",
		})
		expect(legacy?.inputTokens).toBe(100)
		expect(legacy?.outputTokens).toBe(50)
		expect(legacy?.totalTokens).toBe(150)
	})

	it("detects an LLM span from model alone (no operation name)", () => {
		const info = getGenAiInfo({ "gen_ai.request.model": "claude-sonnet-5" })
		expect(info?.model).toBe("claude-sonnet-5")
		expect(info?.operation).toBeNull()
	})
})

describe("getCloudPlatform — gen_ai adapter", () => {
	it("routes an LLM span through the gen_ai adapter", () => {
		const info = getCloudPlatform(OPENROUTER_SPAN)
		expect(info).not.toBeNull()
		expect(info!.id).toBe("gen_ai")
		expect(info!.label).toBe("OpenAI")
		expect(info!.kind).toBe("Chat")
		expect(info!.edge).toBeNull()
	})

	it("exposes model, tokens, and cost as fields", () => {
		const fields = getCloudPlatform(OPENROUTER_SPAN)!.fields
		const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]))
		expect(byLabel["Model"]).toMatchObject({ value: "gpt-4o-2024-08-06", copyable: true })
		expect(byLabel["Requested"]?.value).toBe("openai/gpt-4o")
		expect(byLabel["Tokens"]?.value).toBe("1,234 in · 567 out")
		expect(byLabel["Cost"]?.value).toBe("$0.0091")
		expect(byLabel["Finish"]?.value).toBe("stop")
	})

	it("flags a content_filter / error finish reason as a bad outcome", () => {
		const filtered = getCloudPlatform({
			...OPENROUTER_SPAN,
			"gen_ai.response.finish_reasons": '["content_filter"]',
		})
		expect(filtered!.outcome).toEqual({ value: "content_filter", bad: true })
		// A normal "stop" is never flagged.
		expect(getCloudPlatform(OPENROUTER_SPAN)!.outcome).toBeNull()
	})

	it("does not shadow database or non-LLM spans", () => {
		expect(getCloudPlatform({ "db.system.name": "postgresql" })?.id).toBe("database")
		expect(getCloudPlatform({ "http.request.method": "GET" })).toBeNull()
	})
})

describe("gen_ai formatters", () => {
	it("formats token counts with thousands separators", () => {
		expect(formatTokens(1234567)).toBe("1,234,567")
	})

	it("formats cost with adaptive precision, trimming padding zeros", () => {
		expect(formatGenAiCost(0)).toBe("$0")
		expect(formatGenAiCost(0.0091)).toBe("$0.0091")
		expect(formatGenAiCost(0.25)).toBe("$0.25")
		expect(formatGenAiCost(12.5)).toBe("$12.50")
	})
})
