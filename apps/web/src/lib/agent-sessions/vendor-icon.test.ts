import { describe, expect, it } from "vitest"

import { ChatBubbleSparkleIcon, ClaudeIcon, LangchainIcon, OpenAiIcon } from "@/components/icons"
import { vendorIcon } from "./vendor-icon"

describe("vendorIcon", () => {
	it("gives a recognised framework its brand mark", () => {
		expect(vendorIcon("claude_agent_sdk")).toBe(ClaudeIcon)
		expect(vendorIcon("langchain")).toBe(LangchainIcon)
		// Two ids, one framework: the OpenInference instrumentation is still OpenAI.
		expect(vendorIcon("openai_agents_sdk")).toBe(OpenAiIcon)
		expect(vendorIcon("openinference-openai")).toBe(OpenAiIcon)
	})

	it("falls back for frameworks without a mark, and for no vendor at all", () => {
		expect(vendorIcon("litellm")).toBe(ChatBubbleSparkleIcon)
		expect(vendorIcon("unknown:genai")).toBe(ChatBubbleSparkleIcon)
		expect(vendorIcon("")).toBe(ChatBubbleSparkleIcon)
	})
})
