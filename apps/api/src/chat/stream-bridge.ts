import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { Response as AiResponse } from "effect/unstable/ai"
import { Effect, Stream } from "effect"

/**
 * Bridge Effect AI stream parts to a Vercel AI SDK UIMessageStreamResponse.
 *
 * Effect AI parts carry internal properties (`~effect/ai/Content/Part`, `metadata`)
 * that fail the AI SDK's strict Zod validation. This bridge constructs clean objects
 * with only the exact fields each UIMessageChunk type expects.
 *
 * Mapping:
 *   Effect AI              → AI SDK UIMessageChunk
 *   text-start/delta/end   → text-start/delta/end (same type, pick {id, delta})
 *   reasoning-*            → reasoning-* (same type, pick {id, delta})
 *   tool-params-start      → tool-input-start {toolCallId, toolName}
 *   tool-params-delta      → tool-input-delta {toolCallId, inputTextDelta}
 *   tool-call              → tool-input-available {toolCallId, toolName, input}
 *   tool-result            → tool-output-available {toolCallId, output}
 *   finish                 → finish {finishReason}
 *   error                  → error {errorText}
 *   response-metadata, tool-params-end → (skipped)
 */
export const effectStreamToResponse = (
  stream: Stream.Stream<AiResponse.AnyPart, unknown, never>,
): Response => {
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      await Effect.runPromise(
        stream.pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              const p = part as any
              switch (part.type) {
                // ── Text lifecycle ──────────────────────────────
                case "text-start":
                  writer.write({ type: "text-start", id: p.id })
                  break
                case "text-delta":
                  writer.write({ type: "text-delta", id: p.id, delta: p.delta })
                  break
                case "text-end":
                  writer.write({ type: "text-end", id: p.id })
                  break

                // ── Reasoning lifecycle ────────────────────────
                case "reasoning-start":
                  writer.write({ type: "reasoning-start", id: p.id })
                  break
                case "reasoning-delta":
                  writer.write({ type: "reasoning-delta", id: p.id, delta: p.delta })
                  break
                case "reasoning-end":
                  writer.write({ type: "reasoning-end", id: p.id })
                  break

                // ── Tool input streaming ───────────────────────
                case "tool-params-start":
                  writer.write({
                    type: "tool-input-start",
                    toolCallId: p.id,
                    toolName: p.name,
                  })
                  break
                case "tool-params-delta":
                  writer.write({
                    type: "tool-input-delta",
                    toolCallId: p.id,
                    inputTextDelta: p.delta,
                  })
                  break

                // ── Tool call complete ─────────────────────────
                case "tool-call":
                  writer.write({
                    type: "tool-input-available",
                    toolCallId: p.id,
                    toolName: p.name,
                    input: p.params,
                  } as any)
                  break

                // ── Tool result ────────────────────────────────
                case "tool-result":
                  writer.write({
                    type: "tool-output-available",
                    toolCallId: p.id,
                    output: p.encodedResult,
                  } as any)
                  break

                // ── Finish ─────────────────────────────────────
                case "finish":
                  writer.write({ type: "finish", finishReason: p.reason })
                  break

                // ── Error ──────────────────────────────────────
                case "error":
                  writer.write({
                    type: "error",
                    errorText:
                      p.error instanceof Error
                        ? p.error.message
                        : String(p.error),
                  })
                  break

                // response-metadata, tool-params-end, etc. → skip
              }
            }),
          ),
        ),
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        writer.write({ type: "error", errorText: message } as any)
      })
    },
    onError: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  })

  return createUIMessageStreamResponse({ stream: uiStream })
}
