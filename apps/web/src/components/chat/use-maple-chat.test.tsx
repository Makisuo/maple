// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai"
import type { ChatDashboardContext, ChatMode } from "@maple/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMapleChat } from "./use-maple-chat"

const mockedAuth = vi.hoisted(() => ({
  current: {
    orgId: "org-initial",
    getToken: vi.fn(async () => "token-initial"),
  },
}))

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => mockedAuth.current,
}))

const makeChatResponse = (messageId: string, text: string) =>
  createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId })
        writer.write({ type: "text-start", id: `${messageId}-text` })
        writer.write({
          type: "text-delta",
          id: `${messageId}-text`,
          delta: text,
        })
        writer.write({ type: "text-end", id: `${messageId}-text` })
        writer.write({ type: "finish", finishReason: "stop" })
      },
    }),
  })

describe("useMapleChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mockedAuth.current = {
      orgId: "org-initial",
      getToken: vi.fn(async () => "token-initial"),
    }
  })

  it("uses the latest auth and dashboard context without recreating the transcript", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ headers, body })

        return makeChatResponse(`assistant-${requests.length}`, `reply-${requests.length}`)
      }),
    )

    const initialContext: ChatDashboardContext = {
      dashboardName: "Initial Dashboard",
      existingWidgets: [{ title: "Latency", visualization: "line" }],
    }

    const updatedContext: ChatDashboardContext = {
      dashboardName: "Updated Dashboard",
      existingWidgets: [{ title: "Errors", visualization: "table" }],
    }

    const initialProps: {
      id: string
      mode: ChatMode
      dashboardContext?: ChatDashboardContext
    } = {
      id: "chat-1",
      mode: "default",
      dashboardContext: initialContext,
    }

    const { result, rerender } = renderHook(
      (props: {
        id: string
        mode: ChatMode
        dashboardContext?: ChatDashboardContext
      }) => useMapleChat(props),
      {
        initialProps,
      },
    )

    act(() => {
      result.current.setMessages([
        {
          id: "existing-message",
          role: "assistant",
          parts: [{ type: "text", text: "Existing transcript" }],
        },
      ] satisfies UIMessage[])
    })

    expect(result.current.messages.some((message) => message.id === "existing-message")).toBe(true)

    act(() => {
      result.current.sendText("first request")
    })

    await waitFor(() => expect(requests).toHaveLength(1))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer token-initial")
    expect(requests[0]?.headers.get("X-Org-Id")).toBe("org-initial")
    expect(requests[0]?.body.id).toBe("chat-1")
    expect(Array.isArray(requests[0]?.body.messages)).toBe(true)
    expect(requests[0]?.body.trigger).toBe("submit-message")
    expect(requests[0]?.body.mode).toBe("default")
    expect(requests[0]?.body.dashboardContext).toEqual(initialContext)

    mockedAuth.current = {
      orgId: "org-updated",
      getToken: vi.fn(async () => "token-updated"),
    }

    rerender({
      id: "chat-1",
      mode: "dashboard_builder",
      dashboardContext: updatedContext,
    })

    expect(result.current.messages.some((message) => message.id === "existing-message")).toBe(true)

    act(() => {
      result.current.sendText("second request")
    })

    await waitFor(() => expect(requests).toHaveLength(2))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer token-updated")
    expect(requests[1]?.headers.get("X-Org-Id")).toBe("org-updated")
    expect(requests[1]?.body.id).toBe("chat-1")
    expect(Array.isArray(requests[1]?.body.messages)).toBe(true)
    expect(requests[1]?.body.trigger).toBe("submit-message")
    expect(requests[1]?.body.mode).toBe("dashboard_builder")
    expect(requests[1]?.body.dashboardContext).toEqual(updatedContext)
  })
})
