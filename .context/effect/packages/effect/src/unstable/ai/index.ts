/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `AiError` module provides comprehensive, provider-agnostic error handling
 * for AI operations.
 *
 * This module uses the `reason` pattern where `AiError` is a top-level
 * wrapper error containing `module`, `method`, and a `reason` field that holds
 * the semantic error. This design enables ergonomic error handling while
 * preserving rich context about failures.
 *
 * ## Semantic Error Categories
 *
 * - **RateLimitError** - Request throttled (429s, provider-specific limits)
 * - **QuotaExhaustedError** - Account/billing limits reached
 * - **AuthenticationError** - Invalid/expired credentials
 * - **ContentPolicyError** - Input/output violated content policy
 * - **InvalidRequestError** - Malformed request parameters
 * - **InvalidUserInputError** - Prompt contains unsupported content
 * - **InternalProviderError** - Provider-side failures (5xx)
 * - **NetworkError** - Transport-level failures
 * - **InvalidOutputError** - LLM output parsing/validation failures
 * - **StructuredOutputError** - LLM generated text that doesn't conform to structured output schema
 * - **UnsupportedSchemaError** - Codec transformer rejected a schema with unsupported constructs
 * - **UnknownError** - Catch-all for unknown errors
 *
 * ## Tool Call Errors
 *
 * - **ToolNotFoundError** - Model requested non-existent tool
 * - **ToolParameterValidationError** - Tool call params failed validation
 * - **InvalidToolResultError** - Tool handler returned invalid result
 * - **ToolResultEncodingError** - Tool result encoding failed
 * - **ToolConfigurationError** - Provider tool misconfigured
 *
 * ## Retryability
 *
 * Each reason type has an `isRetryable` getter indicating whether the error is
 * transient. Some errors also provide a `retryAfter` duration hint.
 *
 * @example
 * ```ts
 * import { Effect, Match } from "effect"
 * import type { AiError } from "effect/unstable/ai"
 *
 * // Handle errors using Match on the reason
 * const handleAiError = Match.type<AiError.AiError>().pipe(
 *   Match.when(
 *     { reason: { _tag: "RateLimitError" } },
 *     (err) => Effect.logWarning(`Rate limited, retry after ${err.retryAfter}`)
 *   ),
 *   Match.when(
 *     { reason: { _tag: "AuthenticationError" } },
 *     (err) => Effect.logError(`Auth failed: ${err.reason.kind}`)
 *   ),
 *   Match.when(
 *     { reason: { isRetryable: true } },
 *     (err) => Effect.logWarning(`Transient error, retrying: ${err.message}`)
 *   ),
 *   Match.orElse((err) => Effect.logError(`Permanent error: ${err.message}`))
 * )
 * ```
 *
 * @example
 * ```ts
 * import { Duration, Effect } from "effect"
 * import { AiError } from "effect/unstable/ai"
 *
 * // Create an AiError with a reason
 * const error = AiError.make({
 *   module: "OpenAI",
 *   method: "completion",
 *   reason: new AiError.RateLimitError({
 *     retryAfter: Duration.seconds(60)
 *   })
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message) // "OpenAI.completion: Rate limit exceeded. Retry after 1 minute"
 * ```
 *
 * @since 1.0.0
 */
export * as AiError from "./AiError.ts"

/**
 * Provides a codec transformation for Anthropic structured output.
 *
 * Anthropic's API has specific constraints on JSON schema support that differ
 * from the full JSON Schema specification. This module transforms Effect
 * `Schema.Codec` types into a form compatible with Anthropic's structured
 * output requirements by:
 *
 * - Converting tuples to objects with string keys (tuples are unsupported)
 * - Converting optional properties to nullable unions (`T | null`)
 * - Converting index signatures (records) to arrays of key-value pairs
 * - Converting `oneOf` unions to `anyOf` unions
 * - Stripping unsupported annotations and preserving only Anthropic-compatible
 *   formats and descriptions
 *
 * @since 1.0.0
 */
export * as AnthropicStructuredOutput from "./AnthropicStructuredOutput.ts"

/**
 * The `Chat` module provides a stateful conversation interface for AI language
 * models.
 *
 * This module enables persistent chat sessions that maintain conversation
 * history, support tool calling, and offer both streaming and non-streaming
 * text generation. It integrates seamlessly with the Effect AI ecosystem,
 * providing type-safe conversational AI capabilities.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * // Create a new chat session
 * const program = Effect.gen(function*() {
 *   const chat = yield* Chat.empty
 *
 *   // Send a message and get response
 *   const response = yield* chat.generateText({
 *     prompt: "Hello! What can you help me with?"
 *   })
 *
 *   console.log(response.content)
 *
 *   return response
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * // Streaming chat with tool support
 * const streamingChat = Effect.gen(function*() {
 *   const chat = yield* Chat.empty
 *
 *   yield* chat.streamText({
 *     prompt: "Generate a creative story"
 *   }).pipe(Stream.runForEach((part) => Effect.sync(() => console.log(part))))
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as Chat from "./Chat.ts"

/**
 * The `EmbeddingModel` module provides provider-agnostic text embedding capabilities.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { EmbeddingModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const model = yield* EmbeddingModel.EmbeddingModel
 *   return yield* model.embed("hello world")
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as EmbeddingModel from "./EmbeddingModel.ts"

/**
 * The `IdGenerator` module provides a pluggable system for generating unique identifiers
 * for tool calls and other items in the Effect AI SDKs.
 *
 * This module offers a flexible and configurable approach to ID generation, supporting
 * custom alphabets, prefixes, separators, and sizes.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { IdGenerator } from "effect/unstable/ai"
 *
 * // Using the default ID generator
 * const program = Effect.gen(function*() {
 *   const idGen = yield* IdGenerator.IdGenerator
 *   const toolCallId = yield* idGen.generateId()
 *   console.log(toolCallId) // "id_A7xK9mP2qR5tY8uV"
 *   return toolCallId
 * }).pipe(Effect.provideService(
 *   IdGenerator.IdGenerator,
 *   IdGenerator.defaultIdGenerator
 * ))
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { IdGenerator } from "effect/unstable/ai"
 *
 * // Creating a custom ID generator for AI tool calls
 * const customLayer = IdGenerator.layer({
 *   alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
 *   prefix: "tool_call",
 *   separator: "-",
 *   size: 12
 * })
 *
 * const program = Effect.gen(function*() {
 *   const idGen = yield* IdGenerator.IdGenerator
 *   const id = yield* idGen.generateId()
 *   console.log(id) // "tool_call-A7XK9MP2QR5T"
 *   return id
 * }).pipe(Effect.provide(customLayer))
 * ```
 *
 * @since 4.0.0
 */
export * as IdGenerator from "./IdGenerator.ts"

/**
 * The `LanguageModel` module provides AI text generation capabilities with tool
 * calling support.
 *
 * This module offers a comprehensive interface for interacting with large
 * language models, supporting both streaming and non-streaming text generation,
 * structured output generation, and tool calling functionality. It provides a
 * unified API that can be implemented by different AI providers while
 * maintaining type safety and effect management.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * // Basic text generation
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Explain quantum computing"
 *   })
 *
 *   console.log(response.text)
 *
 *   return response
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * // Structured output generation
 * const ContactSchema = Schema.Struct({
 *   name: Schema.String,
 *   email: Schema.String
 * })
 *
 * const extractContact = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateObject({
 *     prompt: "Extract contact: John Doe, john@example.com",
 *     schema: ContactSchema
 *   })
 *
 *   return response.value
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as LanguageModel from "./LanguageModel.ts"

/**
 * @since 4.0.0
 */
export * as McpSchema from "./McpSchema.ts"

/**
 * @since 4.0.0
 */
export * as McpServer from "./McpServer.ts"

/**
 * The `Model` module provides a unified interface for AI service providers.
 *
 * This module enables creation of provider-specific AI models that can be used
 * interchangeably within the Effect AI ecosystem. It combines Layer
 * functionality with provider identification, allowing for seamless switching
 * between different AI service providers while maintaining type safety.
 *
 * @example
 * ```ts
 * import type { Layer } from "effect"
 * import { Effect } from "effect"
 * import { LanguageModel, Model } from "effect/unstable/ai"
 *
 * declare const myAnthropicLayer: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const anthropicModel = Model.make("anthropic", "claude-3-5-haiku", myAnthropicLayer)
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Hello, world!"
 *   })
 *   return response.text
 * }).pipe(
 *   Effect.provide(anthropicModel)
 * )
 * ```
 *
 * @since 4.0.0
 */
export * as Model from "./Model.ts"

/**
 * Provides codec transformations for OpenAI structured output.
 *
 * @since 1.0.0
 */
export * as OpenAiStructuredOutput from "./OpenAiStructuredOutput.ts"

/**
 * The `Prompt` module provides several data structures to simplify creating and
 * combining prompts.
 *
 * This module defines the complete structure of a conversation with a large
 * language model, including messages, content parts, and provider-specific
 * options. It supports rich content types like text, files, tool calls, and
 * reasoning.
 *
 * @example
 * ```ts
 * import { Prompt } from "effect/unstable/ai"
 *
 * // Create a structured conversation
 * const conversation = Prompt.make([
 *   {
 *     role: "system",
 *     content: "You are a helpful assistant specialized in mathematics."
 *   },
 *   {
 *     role: "user",
 *     content: [{
 *       type: "text",
 *       text: "What is the derivative of x²?"
 *     }]
 *   },
 *   {
 *     role: "assistant",
 *     content: [{
 *       type: "text",
 *       text: "The derivative of x² is 2x."
 *     }]
 *   }
 * ])
 * ```
 *
 * @example
 * ```ts
 * import { Prompt } from "effect/unstable/ai"
 *
 * // Concatenate multiple prompts together sequentially
 * const systemPrompt = Prompt.make([{
 *   role: "system",
 *   content: "You are a coding assistant."
 * }])
 *
 * const userPrompt = Prompt.make("Help me write a function")
 *
 * const combined = Prompt.concat(systemPrompt, userPrompt)
 * ```
 *
 * @since 4.0.0
 */
export * as Prompt from "./Prompt.ts"

/**
 * The `Response` module provides data structures to represent responses from
 * large language models.
 *
 * This module defines the complete structure of AI model responses, including
 * various content parts for text, reasoning, tool calls, files, and metadata,
 * supporting both streaming and non-streaming responses.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * // Create a simple text response part
 * const textResponse = Response.makePart("text", {
 *   text: "The weather is sunny today!"
 * })
 *
 * // Create a tool call response part
 * const toolCallResponse = Response.makePart("tool-call", {
 *   id: "call_123",
 *   name: "get_weather",
 *   params: { city: "San Francisco" },
 *   providerExecuted: false
 * })
 * ```
 *
 * @since 1.0.0
 */
export * as Response from "./Response.ts"

/**
 * @since 4.0.0
 */
export * as ResponseIdTracker from "./ResponseIdTracker.ts"

/**
 * The `Telemetry` module provides OpenTelemetry integration for operations
 * performed against a large language model provider by defining telemetry
 * attributes and utilities that follow the OpenTelemetry GenAI semantic
 * conventions.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Telemetry } from "effect/unstable/ai"
 *
 * // Add telemetry attributes to a span
 * const addTelemetry = Effect.gen(function*() {
 *   const span = yield* Effect.currentSpan
 *
 *   Telemetry.addGenAIAnnotations(span, {
 *     system: "openai",
 *     operation: { name: "chat" },
 *     request: {
 *       model: "gpt-4",
 *       temperature: 0.7,
 *       maxTokens: 1000
 *     },
 *     usage: {
 *       inputTokens: 100,
 *       outputTokens: 50
 *     }
 *   })
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as Telemetry from "./Telemetry.ts"

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
export * as Tokenizer from "./Tokenizer.ts"

/**
 * The `Tool` module provides functionality for defining and managing tools
 * that language models can call to augment their capabilities.
 *
 * This module enables creation of both user-defined and provider-defined tools,
 * with full schema validation, type safety, and handler support. Tools allow
 * AI models to perform actions like searching databases, calling APIs, or
 * executing code within your application context.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Tool } from "effect/unstable/ai"
 *
 * // Define a simple calculator tool
 * const Calculator = Tool.make("Calculator", {
 *   description: "Performs basic arithmetic operations",
 *   parameters: Schema.Struct({
 *     operation: Schema.Literals(["add", "subtract", "multiply", "divide"]),
 *     a: Schema.Number,
 *     b: Schema.Number
 *   }),
 *   success: Schema.Number
 * })
 * ```
 *
 * @since 1.0.0
 */
export * as Tool from "./Tool.ts"

/**
 * The `Toolkit` module allows for creating and implementing a collection of
 * `Tool`s which can be used to enhance the capabilities of a large language
 * model beyond simple text generation.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Tool, Toolkit } from "effect/unstable/ai"
 *
 * // Create individual tools
 * const GetCurrentTime = Tool.make("GetCurrentTime", {
 *   description: "Get the current timestamp",
 *   success: Schema.Number
 * })
 *
 * const GetWeather = Tool.make("GetWeather", {
 *   description: "Get weather for a location",
 *   parameters: Schema.Struct({ location: Schema.String }),
 *   success: Schema.Struct({
 *     temperature: Schema.Number,
 *     condition: Schema.String
 *   })
 * })
 *
 * // Create a toolkit with multiple tools
 * const MyToolkit = Toolkit.make(GetCurrentTime, GetWeather)
 *
 * const MyToolkitLayer = MyToolkit.toLayer({
 *   GetCurrentTime: () => Effect.succeed(Date.now()),
 *   GetWeather: ({ location }) =>
 *     Effect.succeed({
 *       temperature: 72,
 *       condition: "sunny"
 *     })
 * })
 * ```
 *
 * @since 1.0.0
 */
export * as Toolkit from "./Toolkit.ts"
