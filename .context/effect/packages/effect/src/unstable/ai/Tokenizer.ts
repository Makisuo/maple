/**
 * The `Tokenizer` module provides tokenization and text truncation capabilities
 * for large language model text processing workflows.
 *
 * This module offers services for converting text into tokens and truncating
 * prompts based on token limits, essential for managing context length
 * constraints in large language models.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * const tokenizeText = Effect.gen(function*() {
 *   const tokenizer = yield* Tokenizer.Tokenizer
 *   const tokens = yield* tokenizer.tokenize("Hello, world!")
 *   console.log(`Token count: ${tokens.length}`)
 *   return tokens
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * // Truncate a prompt to fit within token limits
 * const truncatePrompt = Effect.gen(function*() {
 *   const tokenizer = yield* Tokenizer.Tokenizer
 *   const longPrompt = "This is a very long prompt..."
 *   const truncated = yield* tokenizer.truncate(longPrompt, 100)
 *   return truncated
 * })
 * ```
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Predicate from "../../Predicate.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as AiError from "./AiError.ts"
import * as Prompt from "./Prompt.ts"

/**
 * The `Tokenizer` service tag for dependency injection.
 *
 * This tag provides access to tokenization functionality throughout your
 * application, enabling token counting and prompt truncation capabilities.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * const useTokenizer = Effect.gen(function*() {
 *   const tokenizer = yield* Tokenizer.Tokenizer
 *   const tokens = yield* tokenizer.tokenize("Hello, world!")
 *   return tokens.length
 * })
 * ```
 *
 * @since 4.0.0
 * @category services
 */
export class Tokenizer extends ServiceMap.Service<Tokenizer, Service>()(
  "effect/ai/Tokenizer"
) {}

/**
 * Tokenizer service interface providing text tokenization and truncation
 * operations.
 *
 * This interface defines the core operations for converting text to tokens and
 * managing content length within token limits for AI model compatibility.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import type { Tokenizer } from "effect/unstable/ai"
 * import { Prompt } from "effect/unstable/ai"
 *
 * const customTokenizer: Tokenizer.Service = {
 *   tokenize: (input) =>
 *     Effect.succeed(input.toString().split(" ").map((_, i) => i)),
 *   truncate: (input, maxTokens) =>
 *     Effect.succeed(Prompt.make(input.toString().slice(0, maxTokens * 5)))
 * }
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface Service {
  /**
   * Converts text input into an array of token numbers.
   */
  readonly tokenize: (
    /**
     * The text input to tokenize.
     */
    input: Prompt.RawInput
  ) => Effect.Effect<Array<number>, AiError.AiError>
  /**
   * Truncates text input to fit within the specified token limit.
   */
  readonly truncate: (
    /**
     * The text input to truncate.
     */
    input: Prompt.RawInput,
    /**
     * Maximum number of tokens to retain.
     */
    tokens: number
  ) => Effect.Effect<Prompt.Prompt, AiError.AiError>
}

/**
 * Creates a Tokenizer service implementation from tokenization options.
 *
 * This function constructs a complete Tokenizer service by providing a
 * tokenization function. The service handles both tokenization and
 * truncation operations using the provided tokenizer.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * // Simple word-based tokenizer
 * const wordTokenizer = Tokenizer.make({
 *   tokenize: (prompt) =>
 *     Effect.succeed(
 *       prompt.content
 *         .flatMap((msg) =>
 *           typeof msg.content === "string"
 *             ? msg.content.split(" ")
 *             : msg.content.flatMap((part) =>
 *               part.type === "text" ? part.text.split(" ") : []
 *             )
 *         )
 *         .map((_, index) => index)
 *     )
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = (options: {
  readonly tokenize: (content: Prompt.Prompt) => Effect.Effect<Array<number>, AiError.AiError>
}): Service =>
  Tokenizer.of({
    tokenize(input) {
      return options.tokenize(Prompt.make(input))
    },
    truncate(input, tokens) {
      return truncate(Prompt.make(input), options.tokenize, tokens)
    }
  })

const truncate = (
  self: Prompt.Prompt,
  tokenize: (input: Prompt.Prompt) => Effect.Effect<Array<number>, AiError.AiError>,
  maxTokens: number
): Effect.Effect<Prompt.Prompt, AiError.AiError> =>
  Effect.suspend(() => {
    let count = 0
    let inputMessages = self.content
    let outputMessages: Array<Prompt.Message> = []
    const loop: Effect.Effect<Prompt.Prompt, AiError.AiError> = Effect.suspend(() => {
      const message = inputMessages[inputMessages.length - 1]
      if (Predicate.isUndefined(message)) {
        return Effect.succeed(Prompt.fromMessages(outputMessages))
      }
      inputMessages = inputMessages.slice(0, inputMessages.length - 1)
      return Effect.flatMap(tokenize(Prompt.fromMessages([message])), (tokens) => {
        count += tokens.length
        if (count > maxTokens) {
          return Effect.succeed(Prompt.fromMessages(outputMessages))
        }
        outputMessages = [message, ...outputMessages]
        return loop
      })
    })
    return loop
  })
