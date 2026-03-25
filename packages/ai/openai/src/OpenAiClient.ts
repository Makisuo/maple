/**
 * OpenAI Client module for interacting with OpenAI's API.
 *
 * Provides a type-safe, Effect-based client for OpenAI operations including
 * completions, embeddings, and streaming responses.
 *
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import * as Cause from "effect/Cause"
import type * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { identity } from "effect/Function"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as RcRef from "effect/RcRef"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker"
import * as Sse from "effect/unstable/encoding/Sse"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Socket from "effect/unstable/socket/Socket"
import * as Generated from "./Generated.ts"
import * as Errors from "./internal/errors.ts"
import { OpenAiConfig } from "./OpenAiConfig.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * The OpenAI client interface.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  /**
   * The underlying generated OpenAI client.
   */
  readonly client: Generated.OpenAiClient

  /**
   * Create a response using the OpenAI responses endpoint.
   */
  readonly createResponse: (
    options: typeof Generated.CreateResponse.Encoded
  ) => Effect.Effect<
    readonly [body: typeof Generated.Response.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  /**
   * Create a streaming response using the OpenAI responses endpoint.
   */
  readonly createResponseStream: (
    options: Omit<typeof Generated.CreateResponse.Encoded, "stream">
  ) => Effect.Effect<
    readonly [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<typeof Generated.ResponseStreamEvent.Type, AiError.AiError>
    ],
    AiError.AiError
  >

  /**
   * Create embeddings using the OpenAI embeddings endpoint.
   */
  readonly createEmbedding: (
    options: typeof Generated.CreateEmbeddingRequest.Encoded
  ) => Effect.Effect<typeof Generated.CreateEmbeddingResponse.Type, AiError.AiError>
}

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service identifier for the OpenAI client.
 *
 * @since 1.0.0
 * @category service
 */
export class OpenAiClient extends ServiceMap.Service<OpenAiClient, Service>()(
  "@effect/ai-openai/OpenAiClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * Options for configuring the OpenAI client.
 *
 * @since 1.0.0
 * @category models
 */
export type Options = {
  /**
   * The OpenAI API key.
   */
  readonly apiKey?: Redacted.Redacted<string> | undefined

  /**
   * The base URL for the OpenAI API.
   *
   * @default "https://api.openai.com/v1"
   */
  readonly apiUrl?: string | undefined

  /**
   * Optional organization ID for multi-org accounts.
   */
  readonly organizationId?: Redacted.Redacted<string> | undefined

  /**
   * Optional project ID for project-scoped requests.
   */
  readonly projectId?: Redacted.Redacted<string> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

const RedactedOpenAiHeaders = {
  OpenAiOrganization: "OpenAI-Organization",
  OpenAiProject: "OpenAI-Project"
}

/**
 * Creates an OpenAI client service with the given options.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = Effect.fnUntraced(
  function*(
    options: Options
  ): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient
    const apiUrl = options.apiUrl ?? "https://api.openai.com/v1"

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest(Function.flow(
        HttpClientRequest.prependUrl(apiUrl),
        options.apiKey
          ? HttpClientRequest.bearerToken(Redacted.value(options.apiKey))
          : identity,
        options.organizationId
          ? HttpClientRequest.setHeader(
            RedactedOpenAiHeaders.OpenAiOrganization,
            Redacted.value(options.organizationId)
          )
          : identity,
        options.projectId
          ? HttpClientRequest.setHeader(
            RedactedOpenAiHeaders.OpenAiProject,
            Redacted.value(options.projectId)
          )
          : identity,
        HttpClientRequest.acceptJson
      )),
      options.transformClient
        ? options.transformClient
        : identity
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const client = Generated.make(httpClient, {
      transformClient: Effect.fnUntraced(function*(client) {
        const config = yield* OpenAiConfig.getOrUndefined
        if (Predicate.isNotUndefined(config?.transformClient)) {
          return config.transformClient(client)
        }
        return client
      })
    })

    const createResponse = (
      payload: typeof Generated.CreateResponse.Encoded
    ): Effect.Effect<
      [body: typeof Generated.Response.Type, response: HttpClientResponse.HttpClientResponse],
      AiError.AiError
    > =>
      client.createResponse({ payload, config: { includeResponse: true } }).pipe(
        Effect.catchTags({
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createResponse"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createResponse"))
        })
      )

    const buildResponseStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [
      HttpClientResponse.HttpClientResponse,
      Stream.Stream<typeof Generated.ResponseStreamEvent.Type, AiError.AiError>
    ] => {
      const stream = response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decodeDataSchema(Generated.ResponseStreamEvent)),
        Stream.takeUntil((event) =>
          event.data.type === "response.completed" ||
          event.data.type === "response.incomplete"
        ),
        Stream.map((event) => event.data),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createResponseStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createResponseStream"))
        })
      ) as any
      return [response, stream]
    }

    const createResponseStream: Service["createResponseStream"] = (payload) =>
      Effect.servicesWith((services) => {
        const socket = ServiceMap.getOrUndefined(services, OpenAiSocket)
        if (socket) return socket.createResponseStream(payload)
        return httpClientOk.execute(
          HttpClientRequest.post("/responses", {
            body: HttpBody.jsonUnsafe({ ...payload, stream: true })
          })
        ).pipe(
          Effect.map(buildResponseStream),
          Effect.catchTag(
            "HttpClientError",
            (error) => Errors.mapHttpClientError(error, "createResponseStream")
          )
        )
      })

    const createEmbedding = (
      payload: typeof Generated.CreateEmbeddingRequest.Encoded
    ): Effect.Effect<typeof Generated.CreateEmbeddingResponse.Type, AiError.AiError> =>
      client.createEmbedding({ payload }).pipe(
        Effect.catchTags({
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createEmbedding"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createEmbedding"))
        })
      )

    return OpenAiClient.of({
      client,
      createResponse,
      createResponseStream,
      createEmbedding
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedOpenAiHeaders))
  )
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the OpenAI client with the given options.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<OpenAiClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenAiClient, make(options))

/**
 * Creates a layer for the OpenAI client, loading the requisite configuration
 * via Effect's `Config` module.
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
   * The config value to load for the organization ID.
   */
  readonly organizationId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The config value to load for the project ID.
   */
  readonly projectId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<OpenAiClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    OpenAiClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey :
        undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl :
        undefined
      const organizationId = Predicate.isNotUndefined(options?.organizationId)
        ? yield* options.organizationId
        : undefined
      const projectId = Predicate.isNotUndefined(options?.projectId)
        ? yield* options.projectId :
        undefined
      return yield* make({
        apiKey,
        apiUrl,
        organizationId,
        projectId,
        transformClient: options?.transformClient
      })
    })
  )

// =============================================================================
// Websocket mode
// =============================================================================

/**
 * @since 1.0.0
 * @category Events
 */
export type ResponseStreamEvent = typeof Generated.ResponseStreamEvent.Type

/**
 * @since 1.0.0
 * @category Websocket mode
 */
export class OpenAiSocket extends ServiceMap.Service<OpenAiSocket, {
  /**
   * Create a streaming response using the OpenAI responses endpoint.
   */
  readonly createResponseStream: (
    options: Omit<typeof Generated.CreateResponse.Encoded, "stream">
  ) => Effect.Effect<
    readonly [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<ResponseStreamEvent, AiError.AiError>
    ],
    AiError.AiError
  >
}>()("@effect/ai-openai/OpenAiClient/OpenAiSocket") {}

const makeSocket = Effect.gen(function*() {
  const client = yield* OpenAiClient
  const tracker = yield* ResponseIdTracker.make
  const request = yield* Effect.orDie(client.client.httpClient.preprocess(HttpClientRequest.post("/responses")))

  const socket = yield* Socket.makeWebSocket(request.url.replace(/^http/, "ws")).pipe(
    Effect.updateService(Socket.WebSocketConstructor, (f) => (url) =>
      f(url, {
        headers: request.headers
      } as any))
  )

  const queueRef = yield* RcRef.make({
    idleTimeToLive: 60_000,
    acquire: Effect.gen(function*() {
      const write = yield* socket.writer

      let currentQueue: Queue.Enqueue<ResponseStreamEvent, AiError.AiError | Cause.Done> | null = null
      const send = (
        queue: Queue.Enqueue<ResponseStreamEvent, AiError.AiError | Cause.Done>,
        message: typeof Generated.CreateResponse.Encoded
      ) =>
        Effect.suspend(() => {
          currentQueue = queue
          return write(JSON.stringify({
            type: "response.create",
            ...message
          }))
        }).pipe(
          Effect.mapError((_error) =>
            AiError.make({
              module: "OpenAiClient",
              method: "createResponseStream",
              reason: new AiError.NetworkError({
                reason: "TransportError",
                request: {
                  method: "POST",
                  url: request.url,
                  urlParams: [],
                  hash: undefined,
                  headers: request.headers
                },
                description: "Failed to send message over WebSocket"
              })
            })
          )
        )

      const cancel = Effect.suspend(() => write(JSON.stringify({ type: "response.cancel" }))).pipe(
        Effect.ignore
      )
      const reset = () => {
        currentQueue = null
      }

      const decoder = new TextDecoder()
      yield* socket.runRaw((msg) => {
        if (!currentQueue) return
        const text = typeof msg === "string" ? msg : decoder.decode(msg)
        try {
          const event = decodeEvent(text)
          if (event.type === "error") {
            tracker.clearUnsafe()
          }
          if (event.type === "error" && "status" in event) {
            const json = JSON.stringify(event.error)
            return Queue.fail(
              currentQueue,
              AiError.make({
                module: "OpenAiClient",
                method: "createResponseStream",
                reason: AiError.reasonFromHttpStatus({
                  description: json,
                  status: event.status,
                  metadata: event.error,
                  http: {
                    body: json,
                    request: {
                      method: "POST",
                      url: request.url,
                      urlParams: [],
                      hash: undefined,
                      headers: request.headers
                    }
                  }
                })
              })
            )
          }
          Queue.offerUnsafe(currentQueue, event)
        } catch {}
      }).pipe(
        Effect.catchCause((cause) => {
          tracker.clearUnsafe()
          return currentQueue ?
            Queue.fail(
              currentQueue,
              AiError.make({
                module: "OpenAiClient",
                method: "createResponseStream",
                reason: new AiError.NetworkError({
                  reason: "TransportError",
                  request: {
                    method: "POST",
                    url: request.url,
                    urlParams: [],
                    hash: undefined,
                    headers: request.headers
                  },
                  description: Cause.pretty(cause)
                })
              })
            ) :
            Effect.void
        }),
        Effect.repeat(
          Schedule.exponential(100, 1.5).pipe(
            Schedule.either(Schedule.spaced({ seconds: 5 })),
            Schedule.jittered
          )
        ),
        Effect.forkScoped
      )

      return { send, cancel, reset } as const
    })
  })

  // Websocket mode only allows one request at a time
  const semaphore = Semaphore.makeUnsafe(1)

  return OpenAiSocket.serviceMap({
    createResponseStream(options) {
      const stream = Effect.gen(function*() {
        yield* Effect.acquireRelease(
          semaphore.take(1),
          () => semaphore.release(1),
          { interruptible: true }
        )
        const { send, cancel, reset } = yield* RcRef.get(queueRef)
        const incoming = yield* Queue.unbounded<ResponseStreamEvent, AiError.AiError | Cause.Done>()
        let done = false

        yield* Effect.acquireRelease(
          send(incoming, options),
          (_, exit) => {
            reset()
            if (Exit.isFailure(exit) && !Exit.hasInterrupts(exit)) return Effect.void
            else if (done) return Effect.void
            return cancel
          },
          { interruptible: true }
        ).pipe(
          Effect.forkScoped({ startImmediately: true })
        )
        return Stream.fromQueue(incoming).pipe(
          Stream.takeUntil((e) => {
            done = e.type === "response.completed" || e.type === "response.incomplete"
            return done
          })
        )
      }).pipe(Stream.unwrap)

      return Effect.succeed([
        HttpClientResponse.fromWeb(request, new Response()),
        stream
      ])
    }
  }).pipe(
    ServiceMap.add(ResponseIdTracker.ResponseIdTracker, tracker)
  )
})

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  status: Schema.Number,
  error: Schema.Struct({
    type: Schema.String,
    message: Schema.String
  })
})

const AllEvents = Schema.Union([Generated.ResponseStreamEvent, ErrorEvent])
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(AllEvents))

/**
 * Uses OpenAI's websocket mode for all responses within the provided effect.
 *
 * Note: This only works with the following WebSocket constructor layers:
 *
 * - `NodeSocket.layerWebSocketConstructorWS`
 * - `BunSocket.layerWebSocketConstructor`
 *
 * This is because it needs to use non-standard options for setting the
 * Authorization header.
 *
 * @since 1.0.0
 * @category Websocket mode
 */
export const withWebSocketMode = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E,
  Exclude<R, OpenAiSocket | ResponseIdTracker.ResponseIdTracker> | OpenAiClient | Socket.WebSocketConstructor
> =>
  Effect.scopedWith((scope) =>
    Effect.flatMap(
      Scope.provide(makeSocket, scope),
      (services) => Effect.provideServices(effect, services)
    )
  )

/**
 * Uses OpenAI's websocket mode for all responses that use the Layer.
 *
 * Note: This only works with the following WebSocket constructor layers:
 *
 * - `NodeSocket.layerWebSocketConstructorWS`
 * - `BunSocket.layerWebSocketConstructor`
 *
 * This is because it needs to use non-standard options for setting the
 * Authorization header.
 *
 * @since 1.0.0
 * @category Websocket mode
 */
export const layerWebSocketMode: Layer.Layer<
  OpenAiSocket | ResponseIdTracker.ResponseIdTracker,
  never,
  OpenAiClient | Socket.WebSocketConstructor
> = Layer.effectServices(makeSocket)
