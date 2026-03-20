// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { UIMessage } from "ai"
import { MapleChatMessages } from "./maple-chat-messages"

describe("MapleChatMessages", () => {
  it("renders text parts and allows tool overrides", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Hello from Maple",
          },
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "add_dashboard_widget",
            state: "output-available",
            input: {
              widgetTitle: "Latency",
            },
            output: {
              tool: "add_dashboard_widget",
              summaryText: "Added widget",
              data: {
                widgetTitle: "Latency",
              },
            },
          },
        ],
      },
    ] satisfies UIMessage[]

    render(
      <MapleChatMessages
        messages={messages}
        isLoading={false}
        renderToolPart={(part) =>
          part.toolName === "add_dashboard_widget"
            ? <div key={part.toolCallId}>Custom widget action</div>
            : null
        }
      />,
    )

    expect(screen.getByText("Hello from Maple")).toBeTruthy()
    expect(screen.getByText("Custom widget action")).toBeTruthy()
  })
})
