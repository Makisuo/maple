import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { decodeChatRequest } from "./request"

describe("decodeChatRequest", () => {
  it("normalizes text parts and trims empty content", async () => {
    const result = await Effect.runPromise(
      decodeChatRequest({
        mode: "default",
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "  hello  " },
              { type: "text", text: "   " },
              { type: "reasoning", text: "ignored" },
            ],
          },
          {
            role: "assistant",
            content: "  world  ",
          },
          {
            role: "assistant",
            content: "   ",
          },
        ],
      }),
    )

    expect(result.mode).toBe("default")
    expect(result.messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
    ])
  })

  it("defaults the mode when omitted", async () => {
    const result = await Effect.runPromise(
      decodeChatRequest({
        messages: [{ role: "user", content: "health?" }],
      }),
    )

    expect(result.mode).toBe("default")
  })
})
