/**
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Path from "../../Path.ts"
import type * as Scope from "../../Scope.ts"
import * as Etag from "./Etag.ts"
import * as HttpClient from "./HttpClient.ts"
import * as ClientRequest from "./HttpClientRequest.ts"
import type * as Middleware from "./HttpMiddleware.ts"
import * as HttpPlatform from "./HttpPlatform.ts"
import type { HttpServerRequest } from "./HttpServerRequest.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"

/**
 * @since 4.0.0
 * @category models
 */
export class HttpServer extends Context.Service<HttpServer, {
  readonly serve: {
    <E, R>(effect: Effect.Effect<HttpServerResponse, E, R>): Effect.Effect<
      void,
      never,
      Exclude<R, HttpServerRequest> | Scope.Scope
    >
    <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
      effect: Effect.Effect<HttpServerResponse, E, R>,
      middleware: Middleware.HttpMiddleware.Applied<App, E, R>
    ): Effect.Effect<
      void,
      never,
      Exclude<R, HttpServerRequest> | Scope.Scope
    >
  }

  readonly address: Address
}>()("effect/http/HttpServer") {}

/**
 * @since 4.0.0
 * @category address
 */
export type Address = UnixAddress | TcpAddress

/**
 * @since 4.0.0
 * @category address
 */
export interface TcpAddress {
  readonly _tag: "TcpAddress"
  readonly hostname: string
  readonly port: number
}

/**
 * @since 4.0.0
 * @category address
 */
export interface UnixAddress {
  readonly _tag: "UnixAddress"
  readonly path: string
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (
  options: {
    readonly serve: (
      httpEffect: Effect.Effect<HttpServerResponse, unknown, HttpServerRequest | Scope.Scope>,
      middleware?: Middleware.HttpMiddleware
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly address: Address
  }
): HttpServer["Service"] => options

/**
 * @since 4.0.0
 * @category accessors
 */
export const serve: {
  (): <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Layer.Layer<never, never, HttpServer | Exclude<R, HttpServerRequest | Scope.Scope>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): (
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Layer.Layer<
    never,
    never,
    HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
  >
  <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ): Layer.Layer<never, never, HttpServer | Exclude<R, HttpServerRequest | Scope.Scope>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    effect: Effect.Effect<HttpServerResponse, E, R>,
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): Layer.Layer<
    never,
    never,
    HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
  >
} = dual((args) => Effect.isEffect(args[0]), <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
  effect: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: Middleware.HttpMiddleware.Applied<App, E, R>
): Layer.Layer<
  never,
  never,
  HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
> =>
  Layer.effectDiscard(
    HttpServer.use((server) => server.serve(effect, middleware!))
  ) as any)

/**
 * @since 4.0.0
 * @category accessors
 */
export const serveEffect: {
  (): <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Effect.Effect<void, never, Scope.Scope | HttpServer | Exclude<R, HttpServerRequest>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): (
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Effect.Effect<
    void,
    never,
    Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
  >
  <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ): Effect.Effect<void, never, Scope.Scope | HttpServer | Exclude<R, HttpServerRequest>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    effect: Effect.Effect<HttpServerResponse, E, R>,
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): Effect.Effect<
    void,
    never,
    Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
  >
} = dual((args) => Effect.isEffect(args[0]), <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
  effect: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: Middleware.HttpMiddleware.Applied<App, E, R>
): Effect.Effect<
  void,
  never,
  Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
> => HttpServer.use((server) => server.serve(effect, middleware!)) as any)

/**
 * @since 4.0.0
 * @category address
 */
export const formatAddress = (address: Address): string => {
  switch (address._tag) {
    case "UnixAddress":
      return `unix://${address.path}`
    case "TcpAddress":
      return `http://${address.hostname}:${address.port}`
  }
}

/**
 * @since 4.0.0
 * @category address
 */
export const addressFormattedWith = <A, E, R>(
  f: (address: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, HttpServer | R> =>
  Effect.flatMap(
    HttpServer.asEffect(),
    (server) => f(formatAddress(server.address))
  )

/**
 * @since 4.0.0
 * @category address
 */
export const logAddress: Effect.Effect<void, never, HttpServer> = addressFormattedWith((_) =>
  Effect.log(`Listening on ${_}`)
)

/**
 * @since 4.0.0
 * @category address
 */
export const withLogAddress = <A, E, R>(
  layer: Layer.Layer<A, E, R>
): Layer.Layer<A, E, R | Exclude<HttpServer, A>> =>
  Layer.effectDiscard(logAddress).pipe(
    Layer.provideMerge(layer)
  )

/**
 * @since 4.0.0
 * @category Testing
 */
export const makeTestClient: Effect.Effect<
  HttpClient.HttpClient,
  never,
  HttpServer | HttpClient.HttpClient
> = Effect.gen(function*() {
  const server = yield* HttpServer
  const client = yield* HttpClient.HttpClient
  const address = server.address
  if (address._tag === "UnixAddress") {
    return yield* Effect.die(new Error("HttpServer.layerTestClient: UnixAddress not supported"))
  }
  const host = address.hostname === "0.0.0.0" ? "127.0.0.1" : address.hostname
  const url = `http://${host}:${address.port}`
  return HttpClient.mapRequest(client, ClientRequest.prependUrl(url))
})

/**
 * @since 4.0.0
 * @category Testing
 */
export const layerTestClient: Layer.Layer<
  HttpClient.HttpClient,
  never,
  HttpServer | HttpClient.HttpClient
> = Layer.effect(HttpClient.HttpClient)(makeTestClient)

/**
 * @since 4.0.0
 * @category Testing
 */
export const layerServices: Layer.Layer<
  | Path.Path
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Etag.Generator
> = Layer.mergeAll(
  HttpPlatform.layer,
  Path.layer,
  Etag.layerWeak
).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)
