/**
 * @since 1.0.0
 */
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Generated from "./Generated.ts"
import * as Errors from "./internal/errors.ts"
import { OpenRouterConfig } from "./OpenRouterConfig.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * The OpenRouter client service interface.
 *
 * Provides methods for interacting with OpenRouter's Chat Completions API,
 * including both synchronous and streaming message creation.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly client: Generated.OpenRouterClient

  readonly createChatCompletion: (
    options: typeof Generated.ChatGenerationParams.Encoded
  ) => Effect.Effect<
    [body: typeof Generated.SendChatCompletionRequest200.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  readonly createChatCompletionStream: (
    options: Omit<typeof Generated.ChatGenerationParams.Encoded, "stream" | "stream_options">
  ) => Effect.Effect<
    [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<ChatStreamingResponseChunkData, AiError.AiError>
    ],
    AiError.AiError
  >
}

/**
 * @since 1.0.0
 * @category Models
 */
export type ChatStreamingResponseChunkData = typeof Generated.ChatStreamingResponseChunk.fields.data.Type

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service identifier for the OpenRouter client.
 *
 * @since 1.0.0
 * @category service
 */
export class OpenRouterClient extends Context.Service<
  OpenRouterClient,
  Service
>()("@effect/ai-openrouter/OpenRouterClient") {}

// =============================================================================
// Options
// =============================================================================

/**
 * Configuration options for creating an OpenRouter client.
 *
 * @since 1.0.0
 * @category models
 */
export type Options = {
  readonly apiKey?: Redacted.Redacted<string> | undefined

  readonly apiUrl?: string | undefined

  /**
   * Optional URL of your site for rankings on `openrouter.ai`.
   */
  readonly siteReferrer?: string | undefined

  /**
   * Optional title of your site for rankings on `openrouter.ai`.
   */
  readonly siteTitle?: string | undefined

  /**
   * Optional transformer for the underlying HTTP client.
   *
   * Use this to add middleware, logging, or custom request/response handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

/**
 * Creates an OpenRouter client service with the given options.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? "https://openrouter.ai/api/v1"),
          options.apiKey ? HttpClientRequest.bearerToken(options.apiKey) : identity,
          options.siteReferrer ? HttpClientRequest.setHeader("HTTP-Referer", options.siteReferrer) : identity,
          options.siteTitle ? HttpClientRequest.setHeader("X-Title", options.siteTitle) : identity,
          HttpClientRequest.acceptJson
        )
      ),
      options.transformClient ?? identity
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const client = Generated.make(httpClient, {
      transformClient: Effect.fnUntraced(function*(client) {
        const config = yield* OpenRouterConfig.getOrUndefined
        if (Predicate.isNotUndefined(config?.transformClient)) {
          return config.transformClient(client)
        }
        return client
      })
    })

    const createChatCompletion: Service["createChatCompletion"] = (payload) =>
      client.sendChatCompletionRequest({ payload, config: { includeResponse: true } }).pipe(
        Effect.catchTags({
          SendChatCompletionRequest400: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest401: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest429: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest500: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createChatCompletion"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createChatCompletion"))
        })
      )

    const buildChatCompletionStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [
      HttpClientResponse.HttpClientResponse,
      Stream.Stream<ChatStreamingResponseChunkData, AiError.AiError>
    ] => {
      const stream = response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((event) => decodeChatCompletionSseData(event.data)),
        Stream.takeWhile((data) => data !== "[DONE]"),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createChatCompletionStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createChatCompletionStream"))
        })
      ) as any
      return [response, stream]
    }

    const createChatCompletionStream: Service["createChatCompletionStream"] = (payload) =>
      httpClientOk.execute(
        HttpClientRequest.post("/chat/completions", {
          body: HttpBody.jsonUnsafe({
            ...payload,
            stream: true,
            stream_options: { include_usage: true }
          })
        })
      ).pipe(
        Effect.map(buildChatCompletionStream),
        Effect.catchTag(
          "HttpClientError",
          (error) => Errors.mapHttpClientError(error, "createChatCompletionStream")
        )
      )

    return OpenRouterClient.of({
      client,
      createChatCompletion,
      createChatCompletionStream
    })
  }
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the OpenRouter client with the given options.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<OpenRouterClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenRouterClient, make(options))

/**
 * Creates a layer for the OpenRouter client, loading the requisite
 * configuration via Effect's `Config` module.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerConfig = (options?: {
  /**
   * The config value to load for the API key.
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The config value to load for the API URL.
   */
  readonly apiUrl?: Config.Config<string> | undefined

  /**
   * The config value to load for the site referrer URL.
   */
  readonly siteReferrer?: Config.Config<string> | undefined

  /**
   * The config value to load for the site title.
   */
  readonly siteTitle?: Config.Config<string> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<OpenRouterClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    OpenRouterClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey
        : undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl
        : undefined
      const siteReferrer = Predicate.isNotUndefined(options?.siteReferrer)
        ? yield* options.siteReferrer
        : undefined
      const siteTitle = Predicate.isNotUndefined(options?.siteTitle)
        ? yield* options.siteTitle
        : undefined
      return yield* make({
        apiKey,
        apiUrl,
        siteReferrer,
        siteTitle,
        transformClient: options?.transformClient
      })
    })
  )

// =============================================================================
// Internal Utilities
// =============================================================================

const ChatStreamingResponseChunkDataFromString = Schema.fromJsonString(Generated.ChatStreamingResponseChunk.fields.data)
const decodeChatStreamingResponseChunkData = Schema.decodeUnknownEffect(ChatStreamingResponseChunkDataFromString)

const decodeChatCompletionSseData = (
  data: string
): Effect.Effect<ChatStreamingResponseChunkData | "[DONE]", Schema.SchemaError> =>
  data === "[DONE]"
    ? Effect.succeed(data)
    : decodeChatStreamingResponseChunkData(data)
