/**
 * Anthropic Client module for interacting with Anthropic's API.
 *
 * Provides a type-safe, Effect-based client for Anthropic operations including
 * messages and streaming responses.
 *
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Sse from "effect/unstable/encoding/Sse"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AnthropicConfig } from "./AnthropicConfig.ts"
import * as Generated from "./Generated.ts"
import * as Errors from "./internal/errors.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * The Anthropic client service interface.
 *
 * Provides methods for interacting with Anthropic's Messages API, including
 * both synchronous and streaming message creation.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  /**
   * The underlying generated Anthropic client providing access to all API
   * endpoints.
   */
  readonly client: Generated.AnthropicClient

  /**
   * Low-level streaming request helper for custom SSE endpoints.
   *
   * Executes an HTTP request and decodes the Server-Sent Events response
   * using the provided schema.
   */
  readonly streamRequest: <
    Type extends {
      readonly id?: string | undefined
      readonly event: string
      readonly data: string
    },
    DecodingServices
  >(
    schema: Schema.Decoder<Type, DecodingServices>
  ) => (request: HttpClientRequest.HttpClientRequest) => Stream.Stream<
    Type,
    HttpClientError.HttpClientError | Schema.SchemaError | Sse.Retry,
    DecodingServices
  >

  /**
   * Creates a message using the Anthropic Messages API.
   *
   * Sends a structured list of input messages and returns the model's
   * generated response. All errors are mapped to the unified `AiError` type.
   */
  readonly createMessage: (options: {
    readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
    readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
  }) => Effect.Effect<
    [body: typeof Generated.BetaMessage.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  /**
   * Creates a streaming message using the Anthropic Messages API.
   *
   * Returns an Effect that yields the HTTP response and a stream of events
   * as the model generates its response. The stream automatically terminates
   * when a `message_stop` event is received. All errors are mapped to the
   * unified `AiError` type.
   */
  readonly createMessageStream: (options: {
    readonly payload: Omit<typeof Generated.BetaCreateMessageParams.Encoded, "stream">
    readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
  }) => Effect.Effect<
    [response: HttpClientResponse.HttpClientResponse, stream: Stream.Stream<MessageStreamEvent, AiError.AiError>],
    AiError.AiError
  >
}

/**
 * Represents an event received from the Anthropic Messages API during a
 * streaming request.
 *
 * Events include:
 * - `message_start`: Initial event containing message metadata
 * - `message_delta`: Incremental updates to the message (e.g., stop reason)
 * - `message_stop`: Final event indicating the message is complete
 * - `content_block_start`: Start of a content block
 * - `content_block_delta`: Incremental content updates (text, tool use, etc.)
 * - `content_block_stop`: End of a content block
 * - `error`: Error events with type and message
 *
 * @since 1.0.0
 * @category models
 */
export type MessageStreamEvent =
  | typeof Generated.BetaMessageStartEvent.Type
  | typeof Generated.BetaMessageDeltaEvent.Type
  | typeof Generated.BetaMessageStopEvent.Type
  | typeof Generated.BetaContentBlockStartEvent.Type
  | typeof Generated.BetaContentBlockDeltaEvent.Type
  | typeof Generated.BetaContentBlockStopEvent.Type
  | typeof Generated.BetaErrorResponse.Type

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service identifier for the Anthropic client.
 *
 * @since 1.0.0
 * @category service
 */
export class AnthropicClient extends ServiceMap.Service<AnthropicClient, Service>()(
  "@effect/ai-anthropic/AnthropicClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * Configuration options for creating an Anthropic client.
 *
 * @since 1.0.0
 * @category models
 */
export type Options = {
  /**
   * The Anthropic API key for authentication.
   *
   * If not provided, requests will be made without authentication (useful for
   * proxied setups or testing).
   */
  readonly apiKey?: Redacted.Redacted<string> | undefined

  /**
   * The base URL for the Anthropic API.
   *
   * Override this to use a proxy or a different API-compatible endpoint.
   *
   * @default "https://api.anthropic.com"
   */
  readonly apiUrl?: string | undefined

  /**
   * The Anthropic API version header value.
   *
   * Controls which version of the API to use. See Anthropic's versioning
   * documentation for available versions and their features.
   *
   * @default "2023-06-01"
   */
  readonly apiVersion?: string | undefined

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

const RedactedAnthropicHeaders = {
  AnthropicApiKey: "x-api-key"
}

/**
 * Creates an Anthropic client service with the given options.
 *
 * The client automatically handles:
 * - API key authentication via the `x-api-key` header
 * - API versioning via the `anthropic-version` header
 * - Error mapping to the unified `AiError` type
 * - Request/response transformations via `AnthropicConfig`
 *
 * Requires an `HttpClient` in the context.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient
    const apiVersion = options.apiVersion ?? "2023-06-01"

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? "https://api.anthropic.com"),
          Predicate.isNotUndefined(options.apiKey)
            ? HttpClientRequest.setHeader(
              RedactedAnthropicHeaders.AnthropicApiKey,
              Redacted.value(options.apiKey)
            )
            : identity,
          HttpClientRequest.setHeader("anthropic-version", apiVersion),
          HttpClientRequest.acceptJson
        )
      ),
      Predicate.isNotUndefined(options.transformClient)
        ? options.transformClient
        : identity
    )

    const client = Generated.make(httpClient, {
      transformClient: Effect.fnUntraced(function*(client) {
        const config = yield* AnthropicConfig.getOrUndefined
        if (Predicate.isNotUndefined(config?.transformClient)) {
          return config.transformClient(client)
        }
        return client
      })
    })

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const streamRequest = <
      Type extends {
        readonly id?: string | undefined
        readonly event: string
        readonly data: string
      },
      DecodingServices
    >(schema: Schema.Decoder<Type, DecodingServices>) =>
    (request: HttpClientRequest.HttpClientRequest): Stream.Stream<
      Type,
      HttpClientError.HttpClientError | Schema.SchemaError | Sse.Retry,
      DecodingServices
    > =>
      httpClientOk.execute(request).pipe(
        Effect.map((response) => response.stream),
        Stream.unwrap,
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decodeSchema(schema))
      )

    const createMessage = (options: {
      readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
      readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
    }): Effect.Effect<
      [body: typeof Generated.BetaMessage.Type, response: HttpClientResponse.HttpClientResponse],
      AiError.AiError
    > =>
      client.betaMessagesPost({ ...options, config: { includeResponse: true } }).pipe(
        Effect.catchTags({
          BetaMessagesPost4XX: (error) => Effect.fail(Errors.mapClientError(error, "createMessage")),
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createMessage"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createMessage"))
        })
      )

    const PingEvent = Schema.Struct({
      type: Schema.Literal("ping")
    })

    const MessageEvent = Schema.Union([
      PingEvent,
      Generated.BetaMessageStartEvent,
      Generated.BetaMessageDeltaEvent,
      Generated.BetaMessageStopEvent,
      Generated.BetaContentBlockStartEvent,
      Generated.BetaContentBlockDeltaEvent,
      Generated.BetaContentBlockStopEvent,
      Generated.BetaErrorResponse
    ])

    const buildMessageStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [HttpClientResponse.HttpClientResponse, Stream.Stream<MessageStreamEvent, AiError.AiError>] => {
      const stream = response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decodeDataSchema(MessageEvent)),
        Stream.takeUntil((event) => event.data.type === "message_stop"),
        Stream.map((event) => event.data),
        Stream.filter((event): event is MessageStreamEvent => event.type !== "ping"),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createMessageStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createMessageStream"))
        })
      ) as any
      return [response, stream]
    }

    const createMessageStream: Service["createMessageStream"] = (options) => {
      const request = HttpClientRequest.post("/v1/messages", {
        headers: Headers.fromInput({
          "anthropic-beta": options.params?.["anthropic-beta"] ?? undefined,
          "anthropic-version": options.params?.["anthropic-version"] ?? apiVersion
        }),
        body: HttpBody.jsonUnsafe({
          ...options.payload,
          stream: true
        })
      })
      return httpClientOk.execute(request).pipe(
        Effect.map(buildMessageStream),
        Effect.catchTag(
          "HttpClientError",
          (error) => Errors.mapHttpClientError(error, "createMessageStream")
        )
      )
    }

    return AnthropicClient.of({
      client,
      streamRequest,
      createMessage,
      createMessageStream
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedAnthropicHeaders))
  )
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the Anthropic client with the given options.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<AnthropicClient, never, HttpClient.HttpClient> =>
  Layer.effect(AnthropicClient, make(options))

/**
 * Creates a layer for the Anthropic client, loading the requisite configuration
 * via Effect's `Config` module.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerConfig = (options?: {
  /**
   * The Anthropic API key for authentication.
   *
   * If not provided, requests will be made without authentication (useful for
   * proxied setups or testing).
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The base URL for the Anthropic API.
   *
   * Override this to use a proxy or a different API-compatible endpoint.
   *
   * @default "https://api.anthropic.com"
   */
  readonly apiUrl?: Config.Config<string> | undefined

  /**
   * The Anthropic API version header value.
   *
   * Controls which version of the API to use. See Anthropic's versioning
   * documentation for available versions and their features.
   *
   * @default "2023-06-01"
   */
  readonly apiVersion?: Config.Config<string> | undefined

  /**
   * Optional transformer for the underlying HTTP client.
   *
   * Use this to add middleware, logging, or custom request/response handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<AnthropicClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    AnthropicClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey :
        undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl :
        undefined
      const apiVersion = Predicate.isNotUndefined(options?.apiVersion)
        ? yield* options.apiVersion :
        undefined
      return yield* make({
        apiKey,
        apiUrl,
        apiVersion,
        transformClient: options?.transformClient
      })
    })
  )
