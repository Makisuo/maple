import { Prompt } from "effect/unstable/ai"
import type { NormalizedChatRequest } from "@maple/domain"
import { DASHBOARD_BUILDER_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt"

export const buildSystemPrompt = (request: NormalizedChatRequest): string => {
  if (request.mode !== "dashboard_builder" || !request.dashboardContext) {
    return SYSTEM_PROMPT
  }

  const widgetList = request.dashboardContext.existingWidgets.length > 0
    ? request.dashboardContext.existingWidgets
        .map((widget) => `- "${widget.title}" (${widget.visualization})`)
        .join("\n")
    : "(none)"

  return `${DASHBOARD_BUILDER_SYSTEM_PROMPT}\n\n## Current Dashboard Context\nDashboard: "${request.dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
}

export const buildPrompt = (request: NormalizedChatRequest): Prompt.RawInput => [
  {
    role: "system",
    content: buildSystemPrompt(request),
  },
  ...request.messages.map((message) => ({
    role: message.role === "system" ? "user" : message.role,
    content: message.parts.map((part) => part.text).join("\n\n"),
  })),
]
