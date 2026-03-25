/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import * as Cookies from "effect/unstable/http/Cookies"
import * as Headers from "effect/unstable/http/Headers"
import type * as Body from "effect/unstable/http/HttpBody"
import * as Client from "effect/unstable/http/HttpClient"
import * as Error from "effect/unstable/http/HttpClientError"
import type { HttpClientRequest } from "effect/unstable/http/HttpClientRequest"
import * as Response from "effect/unstable/http/HttpClientResponse"
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse"
import * as IncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as UrlParams from "effect/unstable/http/UrlParams"
import * as Http from "node:http"
import * as Https from "node:https"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { NodeHttpIncomingMessage } from "./NodeHttpIncomingMessage.ts"
import * as NodeSink from "./NodeSink.ts"
import * as NodeStream from "./NodeStream.ts"
import * as Undici from "./Undici.ts"

// -----------------------------------------------------------------------------
// Fetch
// -----------------------------------------------------------------------------

export {
  /**
   * @since 1.0.0
   * @category Fetch
   */
  Fetch,
  /**
   * @since 1.0.0
   * @category Fetch
   */
  layer as layerFetch,
  /**
   * @since 1.0.0
   * @category Fetch
   */
  RequestInit
} from "effect/unstable/http/FetchHttpClient"

// -----------------------------------------------------------------------------
// Undici
// -----------------------------------------------------------------------------

/**
 * @since 1.0.0
 * @category Dispatcher
 */
export class Dispatcher extends ServiceMap.Service<Dispatcher, Undici.Dispatcher>()(
  "@effect/platform-node/NodeHttpClient/Dispatcher"
) {}

/**
 * @since 1.0.0
 * @category Dispatcher
 */
export const makeDispatcher: Effect.Effect<Undici.Dispatcher, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => new Undici.Agent()),
  (dispatcher) => Effect.promise(() => dispatcher.destroy())
)

/**
 * @since 1.0.0
 * @category Dispatcher
 */
export const layerDispatcher: Layer.Layer<Dispatcher> = Layer.effect(Dispatcher)(makeDispatcher)

/**
 * @since 1.0.0
 * @category Dispatcher
 */
export const dispatcherLayerGlobal: Layer.Layer<Dispatcher> = Layer.sync(Dispatcher)(() => Undici.getGlobalDispatcher())

/**
 * @since 1.0.0
 * @category undici
 */
export const UndiciOptions = ServiceMap.Reference<Partial<Undici.Dispatcher.RequestOptions>>(
  "@effect/platform-node/NodeHttpClient/UndiciOptions",
  { defaultValue: () => ({}) }
)

/**
 * @since 1.0.0
 * @category undici
 */
export const makeUndici = Effect.gen(function*() {
  const dispatcher = yield* Dispatcher
  return Client.make((request, url, signal, fiber) =>
    convertBody(request.body).pipe(
      Effect.flatMap((body) =>
        Effect.tryPromise({
          try: () =>
            dispatcher.request({
              ...fiber.getRef(UndiciOptions),
              signal,
              method: request.method,
              headers: request.headers,
              origin: url.origin,
              path: url.pathname + url.search + url.hash,
              body,
              // leave timeouts to Effect.timeout etc
              headersTimeout: 60 * 60 * 1000,
              bodyTimeout: 0
            }),
          catch: (cause) =>
            new Error.HttpClientError({
              reason: new Error.TransportError({
                request,
                cause
              })
            })
        })
      ),
      Effect.map((response) => new UndiciResponse(request, response))
    )
  )
})

function convertBody(
  body: Body.HttpBody
): Effect.Effect<Exclude<Undici.Dispatcher.DispatchOptions["body"], undefined>> {
  switch (body._tag) {
    case "Empty": {
      return Effect.succeed(null)
    }
    case "Uint8Array":
    case "Raw": {
      return Effect.succeed(body.body as Uint8Array)
    }
    case "FormData": {
      return Effect.succeed(body.formData as any)
    }
    case "Stream": {
      return NodeStream.toReadable(body.stream)
    }
  }
}

function noopErrorHandler(_: any) {}

class UndiciResponse extends Inspectable.Class implements HttpClientResponse, Pipeable {
  readonly [IncomingMessage.TypeId]: typeof IncomingMessage.TypeId
  readonly [Response.TypeId]: typeof Response.TypeId
  readonly request: HttpClientRequest
  readonly source: Undici.Dispatcher.ResponseData

  constructor(
    request: HttpClientRequest,
    source: Undici.Dispatcher.ResponseData
  ) {
    super()
    this[IncomingMessage.TypeId] = IncomingMessage.TypeId
    this[Response.TypeId] = Response.TypeId
    this.request = request
    this.source = source
    source.body.on("error", noopErrorHandler)
  }

  get status() {
    return this.source.statusCode!
  }

  get statusText() {
    return undefined
  }

  get headers(): Headers.Headers {
    return Headers.fromInput(this.source.headers)
  }

  cachedCookies?: Cookies.Cookies
  get cookies(): Cookies.Cookies {
    if (this.cachedCookies !== undefined) {
      return this.cachedCookies
    }
    const header = this.source.headers["set-cookie"]
    return this.cachedCookies = header ? Cookies.fromSetCookie(header) : Cookies.empty
  }

  get remoteAddress(): Option.Option<string> {
    return Option.none()
  }

  get stream(): Stream.Stream<Uint8Array, Error.HttpClientError> {
    return NodeStream.fromReadable({
      evaluate: () => this.source.body,
      onError: (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request: this.request,
            response: this,
            cause
          })
        })
    })
  }

  get json(): Effect.Effect<Schema.Json, Error.HttpClientError> {
    return Effect.flatMap(this.text, (text) =>
      Effect.try({
        try: () => text === "" ? null : JSON.parse(text),
        catch: (cause) =>
          new Error.HttpClientError({
            reason: new Error.DecodeError({
              request: this.request,
              response: this,
              cause
            })
          })
      }))
  }

  private textBody?: Effect.Effect<string, Error.HttpClientError>
  get text(): Effect.Effect<string, Error.HttpClientError> {
    return this.textBody ??= Effect.tryPromise({
      try: () => this.source.body.text(),
      catch: (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request: this.request,
            response: this,
            cause
          })
        })
    }).pipe(Effect.cached, Effect.runSync)
  }

  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, Error.HttpClientError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => UrlParams.fromInput(new URLSearchParams(_)),
        catch: (cause) =>
          new Error.HttpClientError({
            reason: new Error.DecodeError({
              request: this.request,
              response: this,
              cause
            })
          })
      }))
  }

  private formDataBody?: Effect.Effect<FormData, Error.HttpClientError>
  get formData(): Effect.Effect<FormData, Error.HttpClientError> {
    return this.formDataBody ??= Effect.tryPromise({
      try: () => this.source.body.formData() as Promise<FormData>,
      catch: (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request: this.request,
            response: this,
            cause
          })
        })
    }).pipe(Effect.cached, Effect.runSync)
  }

  private arrayBufferBody?: Effect.Effect<ArrayBuffer, Error.HttpClientError>
  get arrayBuffer(): Effect.Effect<ArrayBuffer, Error.HttpClientError> {
    return this.arrayBufferBody ??= Effect.tryPromise({
      try: () => this.source.body.arrayBuffer(),
      catch: (cause) =>
        new Error.HttpClientError({
          reason: new Error.DecodeError({
            request: this.request,
            response: this,
            cause
          })
        })
    }).pipe(Effect.cached, Effect.runSync)
  }

  toJSON(): unknown {
    return IncomingMessage.inspect(this, {
      _id: "effect/http/HttpClientResponse",
      request: this.request.toJSON(),
      status: this.status
    })
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 1.0.0
 * @category Undici
 */
export const layerUndiciNoDispatcher: Layer.Layer<
  Client.HttpClient,
  never,
  Dispatcher
> = Client.layerMergedServices(makeUndici)

/**
 * @since 1.0.0
 * @category Undici
 */
export const layerUndici: Layer.Layer<Client.HttpClient> = Layer.provide(layerUndiciNoDispatcher, layerDispatcher)

// -----------------------------------------------------------------------------
// node:http
// -----------------------------------------------------------------------------

/**
 * @since 1.0.0
 * @category HttpAgent
 */
export class HttpAgent extends ServiceMap.Service<HttpAgent, {
  readonly http: Http.Agent
  readonly https: Https.Agent
}>()("@effect/platform-node/NodeHttpClient/HttpAgent") {}

/**
 * @since 1.0.0
 * @category HttpAgent
 */
export const makeAgent = (options?: Https.AgentOptions): Effect.Effect<HttpAgent["Service"], never, Scope.Scope> =>
  Effect.zipWith(
    Effect.acquireRelease(
      Effect.sync(() => new Http.Agent(options)),
      (agent) => Effect.sync(() => agent.destroy())
    ),
    Effect.acquireRelease(
      Effect.sync(() => new Https.Agent(options)),
      (agent) => Effect.sync(() => agent.destroy())
    ),
    (http, https) => ({ http, https })
  )

/**
 * @since 1.0.0
 * @category HttpAgent
 */
export const layerAgentOptions: (options?: Https.AgentOptions | undefined) => Layer.Layer<
  HttpAgent
> = flow(makeAgent, Layer.effect(HttpAgent))

/**
 * @since 1.0.0
 * @category HttpAgent
 */
export const layerAgent: Layer.Layer<HttpAgent> = layerAgentOptions()

/**
 * @since 1.0.0
 * @category node:http
 */
export const makeNodeHttp = Effect.gen(function*() {
  const agent = yield* HttpAgent
  return Client.make((request, url, signal) => {
    const nodeRequest = url.protocol === "https:" ?
      Https.request(url, {
        agent: agent.https,
        method: request.method,
        headers: request.headers,
        signal
      }) :
      Http.request(url, {
        agent: agent.http,
        method: request.method,
        headers: request.headers,
        signal
      })
    return Effect.forkChild(sendBody(nodeRequest, request, request.body)).pipe(
      Effect.flatMap(() => waitForResponse(nodeRequest, request)),
      Effect.map((_) => new NodeHttpResponse(request, _))
    )
  })
})

const sendBody = (
  nodeRequest: Http.ClientRequest,
  request: HttpClientRequest,
  body: Body.HttpBody
): Effect.Effect<void, Error.HttpClientError> =>
  Effect.suspend((): Effect.Effect<void, Error.HttpClientError> => {
    switch (body._tag) {
      case "Empty": {
        nodeRequest.end()
        return waitForFinish(nodeRequest, request)
      }
      case "Uint8Array":
      case "Raw": {
        nodeRequest.end(body.body)
        return waitForFinish(nodeRequest, request)
      }
      case "FormData": {
        const response = new globalThis.Response(body.formData)

        response.headers.forEach((value, key) => {
          nodeRequest.setHeader(key, value)
        })

        return Effect.tryPromise({
          try: () => pipeline(Readable.fromWeb(response.body! as any), nodeRequest),
          catch: (cause) =>
            new Error.HttpClientError({
              reason: new Error.TransportError({
                request,
                cause
              })
            })
        })
      }
      case "Stream": {
        return Stream.run(
          Stream.mapError(body.stream, (cause) =>
            new Error.HttpClientError({
              reason: new Error.EncodeError({
                request,
                cause
              })
            })),
          NodeSink.fromWritable({
            evaluate: () => nodeRequest,
            onError: (cause) =>
              new Error.HttpClientError({
                reason: new Error.TransportError({
                  request,
                  cause
                })
              })
          })
        )
      }
    }
  })

const waitForResponse = (nodeRequest: Http.ClientRequest, request: HttpClientRequest) =>
  Effect.callback<Http.IncomingMessage, Error.HttpClientError>((resume) => {
    function onError(cause: Error) {
      resume(Effect.fail(
        new Error.HttpClientError({
          reason: new Error.TransportError({
            request,
            cause
          })
        })
      ))
    }
    nodeRequest.on("error", onError)

    function onResponse(response: Http.IncomingMessage) {
      nodeRequest.off("error", onError)
      resume(Effect.succeed(response))
    }
    nodeRequest.on("upgrade", onResponse)
    nodeRequest.on("response", onResponse)

    return Effect.sync(() => {
      nodeRequest.off("error", onError)
      nodeRequest.off("upgrade", onResponse)
      nodeRequest.off("response", onResponse)
    })
  })

const waitForFinish = (nodeRequest: Http.ClientRequest, request: HttpClientRequest) =>
  Effect.callback<void, Error.HttpClientError>((resume) => {
    function onError(cause: Error) {
      resume(Effect.fail(
        new Error.HttpClientError({
          reason: new Error.TransportError({
            request,
            cause
          })
        })
      ))
    }
    nodeRequest.once("error", onError)

    function onFinish() {
      nodeRequest.off("error", onError)
      resume(Effect.void)
    }
    nodeRequest.once("finish", onFinish)

    return Effect.sync(() => {
      nodeRequest.off("error", onError)
      nodeRequest.off("finish", onFinish)
    })
  })

class NodeHttpResponse extends NodeHttpIncomingMessage<Error.HttpClientError> implements HttpClientResponse, Pipeable {
  readonly [Response.TypeId]: typeof Response.TypeId
  readonly request: HttpClientRequest

  constructor(
    request: HttpClientRequest,
    source: Http.IncomingMessage
  ) {
    super(source, (cause) =>
      new Error.HttpClientError({
        reason: new Error.DecodeError({
          request,
          response: this,
          cause
        })
      }))
    this[Response.TypeId] = Response.TypeId
    this.request = request
  }

  get status() {
    return this.source.statusCode!
  }

  cachedCookies?: Cookies.Cookies
  get cookies(): Cookies.Cookies {
    if (this.cachedCookies !== undefined) {
      return this.cachedCookies
    }
    const header = this.source.headers["set-cookie"]
    return this.cachedCookies = header ? Cookies.fromSetCookie(header) : Cookies.empty
  }

  get formData(): Effect.Effect<FormData, Error.HttpClientError> {
    return Effect.tryPromise({
      try: () => {
        const init: {
          headers: HeadersInit
          status?: number
          statusText?: string
        } = {
          headers: new globalThis.Headers(this.source.headers as any)
        }

        if (this.source.statusCode) {
          init.status = this.source.statusCode
        }

        if (this.source.statusMessage) {
          init.statusText = this.source.statusMessage
        }

        return new globalThis.Response(Readable.toWeb(this.source) as any, init).formData()
      },
      catch: this.onError
    })
  }

  toJSON(): unknown {
    return IncomingMessage.inspect(this, {
      _id: "effect/http/HttpClientResponse",
      request: this.request.toJSON(),
      status: this.status
    })
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 1.0.0
 * @category node:http
 */
export const layerNodeHttpNoAgent: Layer.Layer<
  Client.HttpClient,
  never,
  HttpAgent
> = Client.layerMergedServices(makeNodeHttp)

/**
 * @since 1.0.0
 * @category node:http
 */
export const layerNodeHttp: Layer.Layer<Client.HttpClient> = Layer.provide(layerNodeHttpNoAgent, layerAgent)
