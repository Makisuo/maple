import { describe, expect, it } from "vitest"

import { AnthropicIcon, ChatBubbleSparkleIcon, OpenAiIcon } from "@/components/icons"
import { vendorIcon } from "./vendor-icon"

describe("vendorIcon", () => {
	it("gives a recognised framework its brand mark", () => {
		expect(vendorIcon("claude_agent_sdk")).toBe(AnthropicIcon)
		// Two ids, one framework: the OpenInference instrumentation is still OpenAI.
		expect(vendorIcon("openai_agents_sdk")).toBe(OpenAiIcon)
		expect(vendorIcon("openinference-openai")).toBe(OpenAiIcon)
	})

	it("falls back for frameworks without a mark, and for no vendor at all", () => {
		expect(vendorIcon("crewai")).toBe(ChatBubbleSparkleIcon)
		expect(vendorIcon("unknown:genai")).toBe(ChatBubbleSparkleIcon)
		expect(vendorIcon("")).toBe(ChatBubbleSparkleIcon)
	})
})
