import { describe, expect, it } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai"
import { streamAgentLoop } from "./agent-loop"

const PingTool = Tool.make("ping", {
  description: "Ping the system",
  success: Schema.Struct({
    ok: Schema.Boolean,
  }),
})

const PingToolkit = Toolkit.make(PingTool)

describe("streamAgentLoop", () => {
  it("accepts a handled toolkit without erasing the streamed part types", async () => {
    const toolkit = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* PingToolkit
      }).pipe(
        Effect.provide(
          PingToolkit.toLayer({
            ping: () => Effect.succeed({ ok: true }),
          }),
        ),
      ),
    )

    const stream: Stream.Stream<
      Response.StreamPart<{ readonly ping: typeof PingTool }>,
      unknown,
      LanguageModel.LanguageModel
    > = streamAgentLoop({
      prompt: "ping",
      toolkit,
    })

    const model: LanguageModel.Service = {
      generateText: () => Effect.die(new Error("generateText should not run in this test")),
      generateObject: () => Effect.die(new Error("generateObject should not run in this test")),
      streamText: () =>
        Stream.fromIterable([
          Response.makePart("text-start", { id: "text-1" }),
          Response.makePart("text-delta", { id: "text-1", delta: "pong" }),
          Response.makePart("text-end", { id: "text-1" }),
          Response.makePart("finish", {
            reason: "stop",
            response: undefined,
            usage: new Response.Usage({
              inputTokens: {
                uncached: 1,
                total: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 1,
                text: 1,
                reasoning: undefined,
              },
            }),
          }),
        ]),
    }

    const parts = await Effect.runPromise(
      stream.pipe(
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected)),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )

    expect(parts.map((part) => part.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ])
  })
})
