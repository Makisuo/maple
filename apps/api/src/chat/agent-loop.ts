import { LanguageModel, Prompt, type Response } from "effect/unstable/ai"
import { Cause, Duration, Effect, Queue, Stream } from "effect"

const MAX_ITERATIONS = 10
const IDLE_TIMEOUT = Duration.seconds(30)

/**
 * Multi-step streaming agent loop.
 *
 * Calls the model, and if it returns tool calls, appends the tool results
 * to the prompt and calls the model again. Repeats until no tool calls
 * are made or MAX_ITERATIONS is reached.
 *
 * All stream parts (text deltas, tool calls, tool results) from every
 * iteration are emitted in real-time via a Queue-backed stream.
 */
export const streamAgentLoop = <
  TToolkit extends LanguageModel.ToolkitOption<any>,
>(options: {
  readonly prompt: Prompt.RawInput
  readonly toolkit: TToolkit
}) =>
  Effect.gen(function* () {
    type TTools = LanguageModel.ExtractTools<{ readonly toolkit: TToolkit }>

    const queue = yield* Queue.make<Response.StreamPart<TTools>, unknown | Cause.Done>()
    const streamText = LanguageModel.streamText as unknown as (
      options: LanguageModel.GenerateTextOptions<TTools>,
    ) => Stream.Stream<Response.StreamPart<TTools>, unknown, LanguageModel.LanguageModel>

    yield* Effect.gen(function* () {
      let currentPrompt = Prompt.make(options.prompt)

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const collectedParts: Array<Response.StreamPart<TTools>> = []
        const request: LanguageModel.GenerateTextOptions<TTools> = {
          prompt: currentPrompt,
          toolkit: options.toolkit as unknown as LanguageModel.ToolkitOption<TTools>,
        }

        yield* streamText(request).pipe(
          Stream.timeout(IDLE_TIMEOUT),
          Stream.runForEach((part) => {
            collectedParts.push(part)
            return Queue.offer(queue, part)
          }),
        )

        // If no tool calls were made, the model is done responding
        const hasToolCalls = collectedParts.some((p) => p.type === "tool-call")
        if (!hasToolCalls) break

        // Append assistant response + tool results to prompt for next iteration
        currentPrompt = Prompt.concat(currentPrompt, Prompt.fromResponseParts(collectedParts))
      }
    }).pipe(Queue.into(queue), Effect.forkScoped)

    return Stream.fromQueue(queue)
  }).pipe(Stream.unwrap)
