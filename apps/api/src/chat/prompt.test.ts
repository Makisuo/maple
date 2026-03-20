import { describe, expect, it } from "bun:test"
import type { NormalizedChatRequest } from "@maple/domain"
import { buildPrompt, buildSystemPrompt } from "./prompt"
import { DASHBOARD_BUILDER_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt"

describe("chat prompts", () => {
  it("uses the default system prompt outside dashboard mode", () => {
    const request: NormalizedChatRequest = {
      mode: "default",
      messages: [],
    }

    expect(buildSystemPrompt(request)).toBe(SYSTEM_PROMPT)
  })

  it("includes dashboard context in dashboard mode", () => {
    const request: NormalizedChatRequest = {
      mode: "dashboard_builder",
      dashboardContext: {
        dashboardName: "Ops",
        existingWidgets: [
          { title: "Latency", visualization: "chart" },
          { title: "Errors", visualization: "stat" },
        ],
      },
      messages: [
        {
          role: "system",
          parts: [{ type: "text", text: "keep this" }],
        },
      ],
    }

    expect(buildSystemPrompt(request)).toContain(DASHBOARD_BUILDER_SYSTEM_PROMPT)
    expect(buildSystemPrompt(request)).toContain('Dashboard: "Ops"')
    expect(buildSystemPrompt(request)).toContain('- "Latency" (chart)')

    const prompt = buildPrompt(request)
    expect(prompt).toEqual([
      {
        role: "system",
        content: buildSystemPrompt(request),
      },
      {
        role: "user",
        content: "keep this",
      },
    ])
  })
})
