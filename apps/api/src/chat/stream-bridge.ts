import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai"
import { Tool, type Response as AiResponse } from "effect/unstable/ai"
import { Effect, Stream } from "effect"

const toToolFailureText = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }

  if (typeof value === "object" && value !== null && "message" in value) {
    const message = value.message
    if (typeof message === "string") {
      return message
    }
  }

  return JSON.stringify(value, null, 2)
}

const toFinishReason = (reason: AiResponse.AnyPart extends never ? never : string) => {
  switch (reason) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
    case "error":
    case "other":
      return reason
    default:
      return "other"
  }
}

const toChunk = <TTools extends Record<string, Tool.Any>>(
  part: AiResponse.StreamPart<TTools>,
): UIMessageChunk | null => {
  switch (part.type) {
    case "text-start":
      return { type: "text-start", id: part.id }
    case "text-delta":
      return { type: "text-delta", id: part.id, delta: part.delta }
    case "text-end":
      return { type: "text-end", id: part.id }
    case "reasoning-start":
      return { type: "reasoning-start", id: part.id }
    case "reasoning-delta":
      return { type: "reasoning-delta", id: part.id, delta: part.delta }
    case "reasoning-end":
      return { type: "reasoning-end", id: part.id }
    case "tool-params-start":
      return {
        type: "tool-input-start",
        toolCallId: part.id,
        toolName: part.name,
        dynamic: true,
      }
    case "tool-params-delta":
      return {
        type: "tool-input-delta",
        toolCallId: part.id,
        inputTextDelta: part.delta,
      }
    case "tool-call":
      return {
        type: "tool-input-available",
        toolCallId: part.id,
        toolName: part.name,
        input: part.params,
        dynamic: true,
      }
    case "tool-result":
      return part.isFailure
        ? {
            type: "tool-output-error",
            toolCallId: part.id,
            errorText: toToolFailureText(part.encodedResult),
          }
        : {
            type: "tool-output-available",
            toolCallId: part.id,
            output: part.encodedResult,
            preliminary: part.preliminary,
            dynamic: true,
          }
    case "finish":
      return { type: "finish", finishReason: toFinishReason(part.reason) }
    case "error":
      return {
        type: "error",
        errorText: part.error instanceof Error ? part.error.message : String(part.error),
      }
    default:
      return null
  }
}

export const effectStreamToResponse = <
  TTools extends Record<string, Tool.Any>,
>(
  stream: Stream.Stream<AiResponse.StreamPart<TTools>, unknown, never>,
): Response => {
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      await Effect.runPromise(
        stream.pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              const chunk = toChunk(part)
              if (chunk !== null) {
                writer.write(chunk)
              }
            }),
          ),
        ),
      ).catch((error: unknown) => {
        writer.write({
          type: "error",
          errorText: error instanceof Error ? error.message : String(error),
        })
      })
    },
    onError: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  })

  return createUIMessageStreamResponse({ stream: uiStream })
}
