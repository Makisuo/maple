import { describe, expect, it } from "vitest"

import { GEN_AI_LABELS, splitGenAiAttributes } from "../gen-ai"

// Captured verbatim from a `chat openai/gpt-4o-mini` span in the local
// warehouse (Mastra instrumentation through OpenRouter). Note
// `gen_ai.usage.reasoning_tokens`: that spelling is in neither the semconv nor
// the field catalog, and it is exactly the case an unknown key has to survive.
const CHAT_SPAN_ATTRS = {
	"gen_ai.agent.id": "assistant",
	"gen_ai.agent.name": "assistant",
	"gen_ai.conversation.id": "thread-66528ddc-9d69-43d7-bae9-448e5de2a8a6",
	"gen_ai.input.messages": '[{"role":"system","parts":[{"type":"text","content":"You are"}]}]',
	"gen_ai.operation.name": "chat",
	"gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"Hello"}]}]',
	"gen_ai.provider.name": "openrouter",
	"gen_ai.request.max_tokens": "600",
	"gen_ai.request.model": "openai/gpt-4o-mini",
	"gen_ai.request.temperature": "0",
	"gen_ai.response.finish_reasons": '["stop"]',
	"gen_ai.response.id": "gen-1785982835-jFfQ69ybIx6xCLz0OQS8",
	"gen_ai.response.model": "openai/gpt-4o-mini",
	"gen_ai.usage.cache_creation.input_tokens": "0",
	"gen_ai.usage.cache_read.input_tokens": "0",
	"gen_ai.usage.input_tokens": "178",
	"gen_ai.usage.output_tokens": "47",
	"gen_ai.usage.reasoning_tokens": "0",
	"http.request.method": "POST",
	"maple_ai.vendor.id": "unknown:openinference",
}

function fieldsOf(attrs: Record<string, string>, groupId: string) {
	const group = splitGenAiAttributes(attrs).groups.find((candidate) => candidate.id === groupId)
	return (group?.fields ?? []).map((field) => [field.label, field.value])
}

describe("splitGenAiAttributes", () => {
	it("leaves every non-gen_ai key in the raw attribute map", () => {
		const { rest } = splitGenAiAttributes(CHAT_SPAN_ATTRS)

		expect(rest).toEqual({
			"http.request.method": "POST",
			"maple_ai.vendor.id": "unknown:openinference",
		})
	})

	// A warehouse map reads a missing key back as `''`, so a blank value is not
	// worth a labelled row — but it is still a key the span carried, and the raw
	// table listed it before this module existed.
	it("leaves a blank gen_ai value in the raw attribute map too", () => {
		const { groups, rest } = splitGenAiAttributes({
			"gen_ai.operation.name": "chat",
			"gen_ai.request.model": "",
		})

		expect(groups.flatMap((group) => group.fields).map((field) => field.key)).toEqual([
			"gen_ai.operation.name",
		])
		expect(rest).toEqual({ "gen_ai.request.model": "" })
	})

	it("labels and orders the fields of each group", () => {
		expect(fieldsOf(CHAT_SPAN_ATTRS, "operation")).toEqual([
			["Operation", "chat"],
			["Provider", "openrouter"],
		])
		expect(fieldsOf(CHAT_SPAN_ATTRS, "request")).toEqual([
			["Requested model", "openai/gpt-4o-mini"],
			["Max tokens", "600"],
			["Temperature", "0"],
		])
	})

	it("groups by the key's own path when the key has no label", () => {
		// "Reasoning Tokens" beside the counts it belongs with, not in "Other".
		expect(fieldsOf(CHAT_SPAN_ATTRS, "usage")).toEqual([
			["Input", "178"],
			["Output", "47"],
			["Cache read", "0"],
			["Cache write", "0"],
			["Reasoning Tokens", "0"],
		])
	})

	it("unwraps a single-value array so a finish reason reads as one word", () => {
		expect(fieldsOf(CHAT_SPAN_ATTRS, "response")).toContainEqual(["Finish reason", "stop"])
	})

	// The renderer decides between text and the collapsible JSON view by asking
	// whether the split rewrote the string, so a payload has to come through
	// byte-identical.
	it("hands message payloads on untouched", () => {
		const messages = splitGenAiAttributes(CHAT_SPAN_ATTRS).groups.find((group) => group.id === "content")

		expect(messages?.fields.map((field) => [field.label, field.value === field.rawValue])).toEqual([
			["Input messages", true],
			["Output messages", true],
		])
	})

	it("formats token counts and the seconds-valued time to first token", () => {
		const { groups } = splitGenAiAttributes({
			"gen_ai.usage.input_tokens": "1284391",
			"gen_ai.response.time_to_first_chunk": "0.482",
		})
		const fields = Object.fromEntries(
			groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]),
		)

		expect(fields["Input"]).toBe((1284391).toLocaleString())
		expect(fields["Time to first token"]).toBe("482.0ms")
	})

	it("returns no groups for a span with no AI signal", () => {
		expect(splitGenAiAttributes({ "http.request.method": "GET" }).groups).toEqual([])
	})

	it("names a prompt variable by the variable, not the key", () => {
		expect(fieldsOf({ "gen_ai.prompt.variable.tone": "concise" }, "prompt")).toEqual([
			["tone", "concise"],
		])
	})

	// The module's whole premise: this is a reading view, never a filter and
	// never a guess. A key the table has never heard of still renders, in the
	// group its path names, with its value exactly as the span carried it — a
	// digit string is not evidence that a value is a quantity, and re-spelling
	// an id above 2^53 as `1,785,982,835,123,456,800` would print a number the
	// span never had.
	it("renders an unknown key verbatim rather than guessing at its value", () => {
		const { groups } = splitGenAiAttributes({
			"gen_ai.wharrgarbl.frob_count": "3",
			"gen_ai.request.openai.org_id": "1785982835123456789",
			"gen_ai.request.stream": "true",
		})
		const fields = Object.fromEntries(
			groups.flatMap((group) => group.fields).map((field) => [field.key, field.value]),
		)

		expect(fields).toEqual({
			"gen_ai.wharrgarbl.frob_count": "3",
			"gen_ai.request.openai.org_id": "1785982835123456789",
			"gen_ai.request.stream": "true",
		})
		expect(groups.find((group) => group.id === "other")?.fields[0]?.label).toBe("Wharrgarbl Frob Count")
	})

	// Two rows for the same quantity is what the legacy aliases are, and a
	// group where both say "Cache read" is a worse table than the raw one.
	it("gives every field in a group a label of its own", () => {
		const everyKey = Object.fromEntries(Object.keys(GEN_AI_LABELS).map((key) => [key, "x"]))

		for (const group of splitGenAiAttributes(everyKey).groups) {
			const labels = group.fields.map((field) => field.label)
			expect(new Set(labels).size, `duplicate label in "${group.id}"`).toBe(labels.length)
		}
	})
})
