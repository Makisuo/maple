import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan } from "./span-test-support"
import { filterSpans, isDelegation, shortTarget } from "./span-filters"
import type { AiSessionSpan } from "@maple/domain/http"

const SECOND = 1000

const spans = [
	llmSpan({ spanId: "llm", startMs: 0, durationMs: SECOND, model: "openai/gpt-4o-mini" }),
	toolSpan({ spanId: "tool", startMs: SECOND, durationMs: SECOND, toolName: "read_file" }),
	agentSpan({ spanId: "agent", startMs: 2 * SECOND, durationMs: SECOND, agentName: "billing-agent" }),
	// The app's own work, sharing the agent's trace.
	makeSpan({
		spanId: "http",
		startMs: 3 * SECOND,
		durationMs: SECOND,
		spanName: "GET /invoices",
		isAiSpan: false,
	}),
]

const ids = (result: readonly AiSessionSpan[]) => result.map((span) => span.spanId)

describe("filterSpans", () => {
	it("keeps everything for an empty or whitespace-only query", () => {
		expect(ids(filterSpans(spans, "", false))).toEqual(["llm", "tool", "agent", "http"])
		expect(ids(filterSpans(spans, "   ", false))).toEqual(["llm", "tool", "agent", "http"])
	})

	it("matches the span name, model, tool name and agent name, case-insensitively", () => {
		expect(ids(filterSpans(spans, "GPT-4O", false))).toEqual(["llm"])
		expect(ids(filterSpans(spans, "read_file", false))).toEqual(["tool"])
		expect(ids(filterSpans(spans, "billing", false))).toEqual(["agent"])
		expect(ids(filterSpans(spans, "/invoices", false))).toEqual(["http"])
	})

	it("drops non-AI spans when the toolbar asks for agent spans only", () => {
		expect(ids(filterSpans(spans, "", true))).toEqual(["llm", "tool", "agent"])
	})

	it("applies the toggle and the query together", () => {
		expect(ids(filterSpans(spans, "invoices", true))).toEqual([])
	})
})

describe("isDelegation", () => {
	const byId = (...list: readonly AiSessionSpan[]) => new Map(list.map((span) => [span.spanId, span]))

	it("is a handoff when the parent agent span names a different agent", () => {
		const parent = agentSpan({ spanId: "p", startMs: 0, durationMs: 5 * SECOND, agentName: "router" })
		const child = agentSpan({
			spanId: "c",
			parentSpanId: "p",
			startMs: SECOND,
			durationMs: SECOND,
			agentName: "billing-agent",
		})

		expect(isDelegation(child, byId(parent, child))).toBe(true)
	})

	it("is not a handoff when the parent names the same agent (a framework wrapper)", () => {
		const parent = agentSpan({ spanId: "p", startMs: 0, durationMs: 5 * SECOND, agentName: "router" })
		const child = agentSpan({
			spanId: "c",
			parentSpanId: "p",
			startMs: SECOND,
			durationMs: SECOND,
			agentName: "router",
		})

		expect(isDelegation(child, byId(parent, child))).toBe(false)
	})

	// Documented limit: only the immediate parent is read, so an unnamed span
	// between two agents hides the handoff.
	it("misses a handoff through an intermediate span with no agent name", () => {
		const grandparent = agentSpan({
			spanId: "g",
			startMs: 0,
			durationMs: 5 * SECOND,
			agentName: "router",
		})
		const wrapper = makeSpan({
			spanId: "w",
			parentSpanId: "g",
			startMs: SECOND,
			durationMs: 3 * SECOND,
			spanName: "POST /agents/billing",
			isAiSpan: false,
		})
		const child = agentSpan({
			spanId: "c",
			parentSpanId: "w",
			startMs: 2 * SECOND,
			durationMs: SECOND,
			agentName: "billing-agent",
		})

		expect(isDelegation(child, byId(grandparent, wrapper, child))).toBe(false)
	})

	it("is false for a span that is not agent work at all", () => {
		const parent = agentSpan({ spanId: "p", startMs: 0, durationMs: 5 * SECOND, agentName: "router" })
		const tool = toolSpan({ spanId: "t", parentSpanId: "p", startMs: SECOND, durationMs: SECOND })

		expect(isDelegation(tool, byId(parent, tool))).toBe(false)
	})

	it("is false at the root, where there is no parent to compare against", () => {
		const root = agentSpan({ spanId: "r", startMs: 0, durationMs: SECOND, agentName: "router" })

		expect(isDelegation(root, byId(root))).toBe(false)
	})
})

describe("shortTarget", () => {
	it("keeps the last segment of a gateway-prefixed model id", () => {
		expect(shortTarget("openrouter/openai/gpt-4o-mini")).toBe("gpt-4o-mini")
	})

	it("returns an unprefixed value unchanged", () => {
		expect(shortTarget("gpt-4o-mini")).toBe("gpt-4o-mini")
	})

	it("returns the raw value rather than an empty string for a trailing slash", () => {
		expect(shortTarget("openai/")).toBe("openai/")
		expect(shortTarget("")).toBe("")
	})
})
