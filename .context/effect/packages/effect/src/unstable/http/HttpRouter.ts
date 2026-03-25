/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Effect from "../../Effect.ts"
import { compose, dual, identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Tracer from "../../Tracer.ts"
import type * as Types from "../../Types.ts"
import * as FindMyWay from "./FindMyWay.ts"
import * as HttpEffect from "./HttpEffect.ts"
import type * as HttpMethod from "./HttpMethod.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"
import * as HttpServer from "./HttpServer.ts"
import * as HttpServerError from "./HttpServerError.ts"
import * as HttpServerRequest from "./HttpServerRequest.ts"
import * as HttpServerResponse from "./HttpServerResponse.ts"

const TypeId = "~effect/http/HttpRouter"

/**
 * @since 4.0.0
 * @category HttpRouter
 */
export interface HttpRouter {
  readonly [TypeId]: typeof TypeId

  readonly prefixed: (prefix: string) => HttpRouter

  readonly add: <E = never, R = never>(
    method: "*" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    path: PathInput,
    handler:
      | HttpServerResponse.HttpServerResponse
      | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
      | ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>),
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ) => Effect.Effect<
    void,
    never,
    Request.From<"Requires", Exclude<R, Provided>> | Request.From<"Error", E>
  >

  readonly addAll: <const Routes extends ReadonlyArray<Route<any, any>>>(
    routes: Routes
  ) => Effect.Effect<
    void,
    never,
    | Request.From<"Requires", Exclude<Route.Context<Routes[number]>, Provided>>
    | Request.From<"Error", Route.Error<Routes[number]>>
  >

  readonly addGlobalMiddleware: <E, R>(
    middleware:
      & ((
        effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>
      ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>)
      & (Types.unhandled extends E ? unknown : "You cannot handle any errors")
  ) => Effect.Effect<
    void,
    never,
    | Request.From<"GlobalRequires", Exclude<R, GlobalProvided>>
    | Request.From<"GlobalError", Exclude<E, Types.unhandled>>
  >

  readonly asHttpEffect: () => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
}

/**
 * @since 4.0.0
 * @category HttpRouter
 */
export const HttpRouter: ServiceMap.Service<HttpRouter, HttpRouter> = ServiceMap.Service<HttpRouter>(
  "effect/http/HttpRouter"
)

/**
 * @since 4.0.0
 * @category HttpRouter
 */
export const make = Effect.gen(function*() {
  const router = FindMyWay.make<Route<any, never>>(yield* RouterConfig)
  const middleware = new Set<middleware.Fn>()

  const addAll = <const Routes extends ReadonlyArray<Route<any, any>>>(
    routes: Routes
  ): Effect.Effect<
    void,
    never,
    | Request.From<"Requires", Exclude<Route.Context<Routes[number]>, Provided>>
    | Request.From<"Error", Route.Error<Routes[number]>>
  > =>
    Effect.servicesWith((services: ServiceMap.ServiceMap<never>) => {
      const middleware = getMiddleware(services)
      const applyMiddleware = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse>) => {
        for (let i = 0; i < middleware.length; i++) {
          effect = middleware[i](effect)
        }
        return effect
      }
      for (let i = 0; i < routes.length; i++) {
        const route = middleware.length === 0 ? routes[i] : makeRoute({
          ...routes[i],
          handler: applyMiddleware(routes[i].handler as Effect.Effect<HttpServerResponse.HttpServerResponse>)
        })
        if (route.method === "*") {
          if (route.path.endsWith("/*")) {
            router.all(route.path, route as any)
            router.all(route.path.slice(0, -2) as any, route as any)
          } else {
            router.all(route.path, route as any)
          }
        } else {
          if (route.path.endsWith("/*")) {
            router.on(route.method, route.path, route as any)
            router.on(route.method, route.path.slice(0, -2) as any, route as any)
          } else {
            router.on(route.method, route.path, route as any)
          }
        }
      }
      return Effect.void
    })

  return HttpRouter.of({
    [TypeId]: TypeId,
    prefixed(this: HttpRouter, prefix: string) {
      return HttpRouter.of({
        ...this,
        prefixed: (newPrefix: string) => this.prefixed(prefixPath(prefix, newPrefix)),
        addAll: (routes) => addAll(routes.map(prefixRoute(prefix))) as any,
        add: (method, path, handler, options) =>
          addAll([
            makeRoute({
              method,
              path: prefixPath(path, prefix) as PathInput,
              handler: HttpServerResponse.isHttpServerResponse(handler) ?
                Effect.succeed(handler) :
                Effect.isEffect(handler)
                ? handler
                : Effect.flatMap(HttpServerRequest.HttpServerRequest.asEffect(), handler),
              uninterruptible: options?.uninterruptible ?? false,
              prefix
            })
          ])
      })
    },
    addAll,
    add: (method, path, handler, options) => addAll([route(method, path, handler, options)]),
    addGlobalMiddleware: (middleware_) =>
      Effect.sync(() => {
        middleware.add(middleware_ as any)
      }),
    asHttpEffect() {
      let handler = Effect.withFiber<HttpServerResponse.HttpServerResponse, unknown>((fiber) => {
        const contextMap = new Map(fiber.services.mapUnsafe)
        const request = contextMap.get(HttpServerRequest.HttpServerRequest.key) as HttpServerRequest.HttpServerRequest
        let result = router.find(request.method, request.url)
        if (result === undefined && request.method === "HEAD") {
          result = router.find("GET", request.url)
        }
        if (result === undefined) {
          return Effect.fail(
            new HttpServerError.HttpServerError({
              reason: new HttpServerError.RouteNotFound({ request })
            })
          )
        }
        const route = result.handler
        if (Option.isSome(route.prefix)) {
          contextMap.set(HttpServerRequest.HttpServerRequest.key, sliceRequestUrl(request, route.prefix.value))
        }
        contextMap.set(HttpServerRequest.ParsedSearchParams.key, result.searchParams)
        contextMap.set(RouteContext.key, {
          route,
          params: result.params
        })

        const span = contextMap.get(Tracer.ParentSpan.key) as Tracer.Span | undefined
        if (span && span._tag === "Span") {
          span.attribute("http.route", route.path)
        }
        return Effect.provideServices(
          (route.uninterruptible ?
            route.handler :
            Effect.interruptible(route.handler)) as Effect.Effect<
              HttpServerResponse.HttpServerResponse,
              unknown
            >,
          ServiceMap.makeUnsafe(contextMap)
        )
      })
      if (middleware.size === 0) return handler
      for (const fn of Arr.reverse(middleware)) {
        handler = fn(handler as any)
      }
      return handler
    }
  })
})

function sliceRequestUrl(request: HttpServerRequest.HttpServerRequest, prefix: string) {
  const prefexLen = prefix.length
  return request.modify({ url: request.url.length <= prefexLen ? "/" : request.url.slice(prefexLen) })
}

/**
 * @since 4.0.0
 * @category Configuration
 */
export const RouterConfig = ServiceMap.Reference<Partial<FindMyWay.RouterConfig>>(
  "effect/http/HttpRouter/RouterConfig",
  { defaultValue: () => ({}) }
)

/**
 * @since 4.0.0
 * @category RouteContext
 */
export class RouteContext extends ServiceMap.Service<RouteContext, {
  readonly params: Readonly<Record<string, string | undefined>>
  readonly route: Route<unknown, unknown>
}>()("effect/http/HttpRouter/RouteContext") {}

/**
 * @since 4.0.0
 * @category RouteContext
 */
export const params: Effect.Effect<
  ReadonlyRecord<string, string | undefined>,
  never,
  RouteContext
> = Effect.map(RouteContext.asEffect(), (_) => _.params)

/**
 * @since 4.0.0
 * @category Schema
 */
export const schemaJson = <
  A,
  I extends Partial<{
    readonly method: HttpMethod.HttpMethod
    readonly url: string
    readonly cookies: Readonly<Record<string, string | undefined>>
    readonly headers: Readonly<Record<string, string | undefined>>
    readonly pathParams: Readonly<Record<string, string | undefined>>
    readonly searchParams: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
    readonly body: any
  }>,
  RD,
  RE
>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
): Effect.Effect<
  A,
  HttpServerError.HttpServerError | Schema.SchemaError,
  HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams | RouteContext | RD
> => {
  const parse = Schema.decodeUnknownEffect(schema)
  return Effect.servicesWith(
    (
      services: ServiceMap.ServiceMap<
        HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams | RouteContext
      >
    ) => {
      const request = ServiceMap.get(services, HttpServerRequest.HttpServerRequest)
      const searchParams = ServiceMap.get(services, HttpServerRequest.ParsedSearchParams)
      const routeContext = ServiceMap.get(services, RouteContext)
      return Effect.flatMap(request.json, (body) =>
        parse({
          method: request.method,
          url: request.url,
          headers: request.headers,
          cookies: request.cookies,
          pathParams: routeContext.params,
          searchParams,
          body
        }, options))
    }
  )
}

/**
 * @since 4.0.0
 * @category Schema
 */
export const schemaNoBody = <
  A,
  I extends Partial<{
    readonly method: HttpMethod.HttpMethod
    readonly url: string
    readonly cookies: Readonly<Record<string, string | undefined>>
    readonly headers: Readonly<Record<string, string | undefined>>
    readonly pathParams: Readonly<Record<string, string | undefined>>
    readonly searchParams: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
  }>,
  RD,
  RE
>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
): Effect.Effect<
  A,
  Schema.SchemaError,
  HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams | RouteContext | RD
> => {
  const parse = Schema.decodeUnknownEffect(schema)
  return Effect.servicesWith(
    (
      services: ServiceMap.ServiceMap<
        HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams | RouteContext
      >
    ) => {
      const request = ServiceMap.get(services, HttpServerRequest.HttpServerRequest)
      const searchParams = ServiceMap.get(services, HttpServerRequest.ParsedSearchParams)
      const routeContext = ServiceMap.get(services, RouteContext)
      return parse({
        method: request.method,
        url: request.url,
        headers: request.headers,
        cookies: request.cookies,
        pathParams: routeContext.params,
        searchParams
      }, options)
    }
  )
}

/**
 * @since 4.0.0
 * @category Schema
 */
export const schemaParams = <A, I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
): Effect.Effect<A, Schema.SchemaError, HttpServerRequest.ParsedSearchParams | RouteContext | RD> => {
  const parse = Schema.decodeUnknownEffect(schema)
  return Effect.servicesWith((services: ServiceMap.ServiceMap<HttpServerRequest.ParsedSearchParams | RouteContext>) => {
    const searchParams = ServiceMap.get(services, HttpServerRequest.ParsedSearchParams)
    const routeContext = ServiceMap.get(services, RouteContext)
    return parse({ ...searchParams, ...routeContext.params }, options)
  })
}

/**
 * @since 4.0.0
 * @category Schema
 */
export const schemaPathParams = <A, I extends Readonly<Record<string, string | undefined>>, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
): Effect.Effect<A, Schema.SchemaError, RouteContext | RD> => {
  const parse = Schema.decodeUnknownEffect(schema)
  return Effect.flatMap(params, (_) => parse(_, options))
}

/**
 * A helper function that is the equivalent of:
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as Layer from "effect/Layer"
 * import * as HttpRouter from "effect/unstable/http/HttpRouter"
 *
 * const MyRoute = Layer.effectDiscard(Effect.gen(function*() {
 *   const router = yield* HttpRouter.HttpRouter
 *
 *   // then use `yield* router.add(...)` to add a route
 * }))
 * ```
 *
 * @since 4.0.0
 * @category HttpRouter
 */
export const use = <A, E, R>(
  f: (router: HttpRouter) => Effect.Effect<A, E, R>
): Layer.Layer<never, E, HttpRouter | Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(Effect.flatMap(HttpRouter.asEffect(), f))

/**
 * Create a layer that adds a single route to the HTTP router.
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as HttpRouter from "effect/unstable/http/HttpRouter"
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
 *
 * const Route = HttpRouter.add(
 *   "GET",
 *   "/hello",
 *   Effect.succeed(HttpServerResponse.text("Hello, World!"))
 * )
 * ```
 *
 * @since 4.0.0
 * @category HttpRouter
 */
export const add = <E = never, R = never>(
  method: "*" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
  path: PathInput,
  handler:
    | HttpServerResponse.HttpServerResponse
    | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    | ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>),
  options?: {
    readonly uninterruptible?: boolean | undefined
  }
): Layer.Layer<never, never, HttpRouter | Request.From<"Requires", Exclude<R, Provided>> | Request.From<"Error", E>> =>
  use((router) => router.add(method, path, handler, options))

/**
 * Create a layer that adds multiple routes to the HTTP router.
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as HttpRouter from "effect/unstable/http/HttpRouter"
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
 *
 * const Routes = HttpRouter.addAll([
 *   HttpRouter.route(
 *     "GET",
 *     "/hello",
 *     Effect.succeed(HttpServerResponse.text("Hello, World!"))
 *   )
 * ])
 * ```
 *
 * @since 4.0.0
 * @category HttpRouter
 */
export const addAll = <Routes extends ReadonlyArray<Route<any, any>>, EX = never, RX = never>(
  routes: Routes | Effect.Effect<Routes, EX, RX>,
  options?: {
    readonly prefix?: string | undefined
  }
): Layer.Layer<
  never,
  EX,
  | HttpRouter
  | Exclude<RX, Scope.Scope>
  | Request.From<"Requires", Exclude<Route.Context<Routes[number]>, Provided>>
  | Request.From<"Error", Route.Error<Routes[number]>>
> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const toAdd = Effect.isEffect(routes) ? yield* routes : routes
    let router = yield* HttpRouter
    if (options?.prefix) {
      router = router.prefixed(options.prefix)
    }
    yield* router.addAll(toAdd)
  }))

/**
 * @since 4.0.0
 * @category HttpRouter
 */
export const layer: Layer.Layer<HttpRouter> = Layer.effect(HttpRouter)(make)

/**
 * @since 4.0.0
 * @category HttpRouter
 */
export const toHttpEffect = <A, E, R>(
  appLayer: Layer.Layer<A, E, R>
): Effect.Effect<
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Request.Only<"Error", R> | Request.Only<"GlobalRequires", R> | HttpServerError.HttpServerError,
    Scope.Scope | HttpServerRequest.HttpServerRequest | Request.Only<"Requires", R> | Request.Only<"GlobalRequires", R>
  >,
  Request.Without<E>,
  Exclude<Request.Without<R>, HttpRouter> | Scope.Scope
> =>
  Effect.gen(function*() {
    const context = yield* Layer.build(Layer.provideMerge(appLayer, layer))
    const router = ServiceMap.get(context, HttpRouter)
    // @effect-diagnostics effect/returnEffectInGen:off
    return router.asHttpEffect()
  }) as any

const RouteTypeId = "~effect/http/HttpRouter/Route"

/**
 * @since 4.0.0
 * @category Route
 */
export interface Route<E = never, R = never> {
  readonly [RouteTypeId]: typeof RouteTypeId
  readonly method: HttpMethod.HttpMethod | "*"
  readonly path: PathInput
  readonly handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  readonly uninterruptible: boolean
  readonly prefix: Option.Option<string>
}

/**
 * @since 4.0.0
 * @category Route
 */
export declare namespace Route {
  /**
   * @since 4.0.0
   * @category Route
   */
  export type Error<R extends Route<any, any>> = R extends Route<infer E, infer _R> ? E : never

  /**
   * @since 4.0.0
   * @category Route
   */
  export type Context<T extends Route<any, any>> = T extends Route<infer _E, infer R> ? R : never
}

const makeRoute = <E, R>(options: {
  readonly method: HttpMethod.HttpMethod | "*"
  readonly path: PathInput
  readonly handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  readonly uninterruptible?: boolean | undefined
  readonly prefix?: Option.Option<string> | string | undefined
}): Route<E, Exclude<R, Provided>> =>
  ({
    ...options,
    uninterruptible: options.uninterruptible ?? false,
    prefix: typeof options.prefix === "string" ? Option.some(options.prefix) : options.prefix ?? Option.none(),
    [RouteTypeId]: RouteTypeId
  }) as Route<E, Exclude<R, Provided>>

/**
 * @since 4.0.0
 * @category Route
 */
export const route = <E = never, R = never>(
  method: "*" | HttpMethod.HttpMethod,
  path: PathInput,
  handler:
    | HttpServerResponse.HttpServerResponse
    | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    | ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>),
  options?: {
    readonly uninterruptible?: boolean | undefined
  }
): Route<E, Exclude<R, Provided>> =>
  makeRoute({
    ...options,
    method,
    path,
    handler: HttpServerResponse.isHttpServerResponse(handler) ?
      Effect.succeed(handler) :
      Effect.isEffect(handler)
      ? handler
      : Effect.flatMap(HttpServerRequest.HttpServerRequest.asEffect(), handler),
    uninterruptible: options?.uninterruptible ?? false
  })

/**
 * @since 4.0.0
 * @category PathInput
 */
export type PathInput = `/${string}` | "*"

const removeTrailingSlash = (
  path: PathInput
): PathInput => (path.endsWith("/") ? path.slice(0, -1) : path) as any

/**
 * @since 4.0.0
 * @category PathInput
 */
export const prefixPath: {
  (prefix: string): (self: string) => string
  (self: string, prefix: string): string
} = dual(2, (self: string, prefix: string) => {
  prefix = removeTrailingSlash(prefix as PathInput)
  if (self === "*") return `${prefix}/*`
  else if (self === "/") return prefix
  return prefix + self
})

/**
 * @since 4.0.0
 * @category Route
 */
export const prefixRoute: {
  (prefix: string): <E, R>(self: Route<E, R>) => Route<E, R>
  <E, R>(self: Route<E, R>, prefix: string): Route<E, R>
} = dual(2, <E, R>(self: Route<E, R>, prefix: string): Route<E, R> =>
  makeRoute({
    ...self,
    path: prefixPath(self.path, prefix) as PathInput,
    prefix: Option.match(self.prefix, {
      onNone: () => prefix as string,
      onSome: (existingPrefix) => prefixPath(existingPrefix, prefix) as string
    })
  }))

/**
 * Represents a request-level dependency, that needs to be provided by
 * middleware.
 *
 * @since 4.0.0
 * @category Request types
 */
export interface Request<Kind extends string, T> {
  readonly _: unique symbol
  readonly kind: Kind
  readonly type: T
}

/**
 * @since 4.0.0
 * @category Request types
 */
export declare namespace Request {
  /**
   * @since 4.0.0
   * @category Request types
   */
  export type From<Kind extends string, R> = R extends infer T ? Request<Kind, T> : never

  /**
   * @since 4.0.0
   * @category Request types
   */
  export type Only<Kind extends string, A> = A extends Request<Kind, infer T> ? T : never

  /**
   * @since 4.0.0
   * @category Request types
   */
  export type Without<A> = A extends Request<infer _Kind, infer _> ? never : A
}

/**
 * Services provided by the HTTP router, which are available in the
 * request context.
 *
 * @since 4.0.0
 * @category Request types
 */
export type Provided =
  | HttpServerRequest.HttpServerRequest
  | Scope.Scope
  | HttpServerRequest.ParsedSearchParams
  | RouteContext

/**
 * Services provided to global middleware.
 *
 * @since 4.0.0
 * @category Request types
 */
export type GlobalProvided =
  | HttpServerRequest.HttpServerRequest
  | Scope.Scope

const MiddlewareTypeId = "~effect/http/HttpRouter/Middleware"

/**
 * @since 4.0.0
 * @category Middleware
 */
export interface Middleware<
  Config extends {
    provides: any
    handles: any
    error: any
    requires: any
    layerError: any
    layerRequires: any
  }
> {
  readonly [MiddlewareTypeId]: Config

  readonly layer: [Config["requires"]] extends [never] ? Layer.Layer<
      Request.From<"Requires", Config["provides"]>,
      Config["layerError"],
      | Config["layerRequires"]
      | Request.From<"Requires", Config["requires"]>
      | Request.From<"Error", Config["error"]>
    >
    : "Need to .combine(middleware) that satisfy the missing request dependencies"

  readonly combine: <
    Config2 extends {
      provides: any
      handles: any
      error: any
      requires: any
      layerError: any
      layerRequires: any
    }
  >(other: Middleware<Config2>) => Middleware<{
    provides: Config2["provides"] | Config["provides"]
    handles: Config2["handles"] | Config["handles"]
    error: Config2["error"] | Exclude<Config["error"], Config2["handles"]>
    requires: Exclude<Config["requires"], Config2["provides"]> | Config2["requires"]
    layerError: Config["layerError"] | Config2["layerError"]
    layerRequires: Config["layerRequires"] | Config2["layerRequires"]
  }>
}

/**
 * Create a middleware layer that can be used to modify requests and responses.
 *
 * By default, the middleware only affects the routes that it is provided to.
 *
 * If you want to create a middleware that applies globally to all routes, pass
 * the `global` option as `true`.
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as Layer from "effect/Layer"
 * import * as ServiceMap from "effect/ServiceMap"
 * import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
 * import * as HttpRouter from "effect/unstable/http/HttpRouter"
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
 *
 * // Here we are defining a CORS middleware
 * const CorsMiddleware = HttpRouter.middleware(HttpMiddleware.cors()).layer
 * // You can also use HttpRouter.cors() to create a CORS middleware
 *
 * class CurrentSession extends ServiceMap.Service<CurrentSession, {
 *   readonly token: string
 * }>()("CurrentSession") {}
 *
 * // You can create middleware that provides a service to the HTTP requests.
 * const SessionMiddleware = HttpRouter.middleware<{
 *   provides: CurrentSession
 * }>()(
 *   Effect.gen(function*() {
 *     yield* Effect.log("SessionMiddleware initialized")
 *
 *     return (httpEffect) =>
 *       Effect.provideService(httpEffect, CurrentSession, {
 *         token: "dummy-token"
 *       })
 *   })
 * ).layer
 *
 * Effect.gen(function*() {
 *   const router = yield* HttpRouter.HttpRouter
 *   yield* router.add(
 *     "GET",
 *     "/hello",
 *     Effect.gen(function*() {
 *       // Requests can now access the current session
 *       const session = yield* CurrentSession
 *       return HttpServerResponse.text(
 *         `Hello, World! Your token is ${session.token}`
 *       )
 *     })
 *   )
 * }).pipe(
 *   Layer.effectDiscard,
 *   // Provide the SessionMiddleware & CorsMiddleware to some routes
 *   Layer.provide([SessionMiddleware, CorsMiddleware])
 * )
 * ```
 *
 * @since 4.0.0
 * @category Middleware
 */
export const middleware:
  & middleware.Make<never, never>
  & (<
    Config extends {
      provides?: any
      handles?: any
    } = {}
  >() => middleware.Make<
    Config extends { provides: infer R } ? R : never,
    Config extends { handles: infer E } ? E : never
  >) = function() {
    if (arguments.length === 0) {
      return makeMiddleware as any
    }
    return makeMiddleware(arguments[0], arguments[1]) as any
  }

const makeMiddleware = (middleware: any, options?: {
  readonly global?: boolean | undefined
}) =>
  options?.global ?
    Layer.effectDiscard(Effect.gen(function*() {
      const router = yield* HttpRouter
      const fn = Effect.isEffect(middleware) ? yield* middleware : middleware
      yield* router.addGlobalMiddleware(fn)
    }))
    : new MiddlewareImpl(
      Effect.isEffect(middleware) ?
        Layer.effectServices(Effect.map(middleware, (fn) => ServiceMap.makeUnsafe(new Map([[fnContextKey, fn]])))) :
        Layer.succeedServices(ServiceMap.makeUnsafe(new Map([[fnContextKey, middleware]]))) as any
    )

let middlewareId = 0
const fnContextKey = "effect/http/HttpRouter/MiddlewareFn"

class MiddlewareImpl<
  Config extends {
    provides: any
    handles: any
    error: any
    requires: any
    layerError: any
    layerRequires: any
  }
> implements Middleware<Config> {
  readonly [MiddlewareTypeId]: Config = {} as any

  readonly layerFn: Layer.Layer<never>
  readonly dependencies?: Layer.Layer<any, any, any> | undefined

  constructor(
    layerFn: Layer.Layer<never>,
    dependencies?: Layer.Layer<any, any, any>
  ) {
    this.layerFn = layerFn
    this.dependencies = dependencies
    const contextKey = `effect/http/HttpRouter/Middleware-${++middlewareId}` as const
    this.layer = Layer.effectServices(Effect.gen({ self: this }, function*() {
      const context = yield* Effect.services<Scope.Scope>()
      const stack = [context.mapUnsafe.get(fnContextKey)]
      if (this.dependencies) {
        const memoMap = yield* Layer.CurrentMemoMap
        const scope = ServiceMap.get(context, Scope.Scope)
        const depsContext = yield* Layer.buildWithMemoMap(this.dependencies, memoMap, scope)
        stack.push(...getMiddleware(depsContext))
      }
      return ServiceMap.makeUnsafe<never>(new Map([[contextKey, stack]]))
    })).pipe(Layer.provide(this.layerFn))
  }

  layer: any

  combine<
    Config2 extends {
      provides: any
      handles: any
      error: any
      requires: any
      layerError: any
      layerRequires: any
    }
  >(other: Middleware<Config2>): Middleware<any> {
    return new MiddlewareImpl(
      this.layerFn,
      this.dependencies ? Layer.provideMerge(this.dependencies, other.layer as any) : other.layer as any
    ) as any
  }
}

const middlewareCache = new WeakMap<ServiceMap.ServiceMap<never>, any>()
const getMiddleware = (context: ServiceMap.ServiceMap<never>): Array<middleware.Fn> => {
  let arr = middlewareCache.get(context)
  if (arr) return arr
  const topLevel = Arr.empty<Array<middleware.Fn>>()
  let maxLength = 0
  for (const [key, value] of context.mapUnsafe) {
    if (key.startsWith("effect/http/HttpRouter/Middleware-")) {
      topLevel.push(value)
      if (value.length > maxLength) {
        maxLength = value.length
      }
    }
  }
  if (topLevel.length === 0) {
    arr = []
  } else {
    const middleware = new Set<middleware.Fn>()
    for (let i = maxLength - 1; i >= 0; i--) {
      for (const arr of topLevel) {
        if (i < arr.length) {
          middleware.add(arr[i])
        }
      }
    }
    arr = Arr.fromIterable(middleware).reverse()
  }
  middlewareCache.set(context, arr)
  return arr
}

/**
 * @since 4.0.0
 * @category Middleware
 */
export declare namespace middleware {
  /**
   * @since 4.0.0
   * @category Middleware
   */
  export type Make<Provides = never, Handles = never> = {
    <E, R, EX, RX, const Global extends boolean = false>(
      middleware: Effect.Effect<
        (
          effect: Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            Types.NoInfer<Handles | Types.unhandled>,
            Types.NoInfer<Provides>
          >
        ) =>
          & Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            E,
            R
          >
          & (Types.unhandled extends E ? unknown : "You must only handle the configured errors"),
        EX,
        RX
      >,
      options?: {
        readonly global?: Global | undefined
      }
    ): Global extends true ? Layer.Layer<
        | Request.From<"Requires", Provides>
        | Request.From<"Error", Handles>
        | Request.From<"GlobalRequires", Provides>
        | Request.From<"GlobalError", Handles>,
        EX,
        | HttpRouter
        | Exclude<RX, Scope.Scope>
        | Request.From<"GlobalRequires", Exclude<R, GlobalProvided>>
        | Request.From<"GlobalError", Exclude<E, Types.unhandled>>
      > :
      Middleware<{
        provides: Provides
        handles: Handles
        error: Exclude<E, Types.unhandled>
        requires: Exclude<R, Provided>
        layerError: EX
        layerRequires: Exclude<RX, Scope.Scope>
      }>
    <E, R, const Global extends boolean = false>(
      middleware:
        & ((
          effect: Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            Types.NoInfer<Handles | Types.unhandled>,
            Types.NoInfer<Provides>
          >
        ) => Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          E,
          R
        >)
        & (Types.unhandled extends E ? unknown : "You must only handle the configured errors"),
      options?: {
        readonly global?: Global | undefined
      }
    ): Global extends true ? Layer.Layer<
        | Request.From<"Requires", Provides>
        | Request.From<"Error", Handles>
        | Request.From<"GlobalRequires", Provides>
        | Request.From<"GlobalError", Handles>,
        never,
        | HttpRouter
        | Request.From<"GlobalRequires", Exclude<R, GlobalProvided>>
        | Request.From<"GlobalError", Exclude<E, Types.unhandled>>
      > :
      Middleware<{
        provides: Provides
        handles: Handles
        error: Exclude<E, Types.unhandled>
        requires: Exclude<R, Provided>
        layerError: never
        layerRequires: never
      }>
  }

  /**
   * @since 4.0.0
   * @category Middleware
   */
  export type Fn = (
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse>
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}

/**
 * A middleware that applies CORS headers to the HTTP response.
 *
 * @since 4.0.0
 * @category Middleware
 */
export const cors = (
  options?: {
    readonly allowedOrigins?: ReadonlyArray<string> | undefined
    readonly allowedMethods?: ReadonlyArray<string> | undefined
    readonly allowedHeaders?: ReadonlyArray<string> | undefined
    readonly exposedHeaders?: ReadonlyArray<string> | undefined
    readonly maxAge?: number | undefined
    readonly credentials?: boolean | undefined
  } | undefined
): Layer.Layer<never, never, HttpRouter> => middleware(HttpMiddleware.cors(options), { global: true })

/**
 * A middleware that disables the logger for some routes.
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as Layer from "effect/Layer"
 * import * as HttpRouter from "effect/unstable/http/HttpRouter"
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
 *
 * const Route = HttpRouter.add(
 *   "GET",
 *   "/hello",
 *   Effect.succeed(HttpServerResponse.text("Hello, World!"))
 * ).pipe(
 *   // disable the logger for this route
 *   Layer.provide(HttpRouter.disableLogger)
 * )
 * ```
 *
 * @since 4.0.0
 * @category Middleware
 */
export const disableLogger: Layer.Layer<never> = middleware(HttpMiddleware.withLoggerDisabled).layer

/**
 * Provides request-level dependencies to some routes.
 *
 * @since 4.0.0
 * @category Middleware
 */
export const provideRequest =
  <A2, E2, R2>(layer: Layer.Layer<A2, E2, R2>) =>
  <A, E, R>(self: Layer.Layer<A, E, R>): Layer.Layer<
    A,
    E | E2,
    R2 | Exclude<R, Request.From<"Requires", A2>>
  > =>
    Layer.provide(
      self,
      middleware<{ provides: A2 }>()(Effect.gen(function*() {
        const services = yield* Layer.build(layer as Layer.Layer<A2>)
        return (effect) =>
          Effect.provideServices(effect, services) as Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            Types.unhandled
          >
      })).layer
    )

/**
 * Serves the provided application layer as an HTTP server.
 *
 * @since 4.0.0
 * @category Server
 */
export const serve = <A, E, R, HE, HR = Request.Only<"Requires", R> | Request.Only<"GlobalRequires", R>>(
  appLayer: Layer.Layer<A, E, R>,
  options?: {
    readonly routerConfig?: Partial<FindMyWay.RouterConfig> | undefined
    readonly disableLogger?: boolean | undefined
    readonly disableListenLog?: boolean
    /**
     * Middleware to apply to the HTTP server.
     *
     * NOTE: This middleware is applied to the entire HTTP server chain,
     * including the sending of the response. This means that modifications
     * to the response **WILL NOT** be reflected in the final response sent to the
     * client.
     *
     * Use HttpRouter.middleware to create middleware that can modify the
     * response.
     */
    readonly middleware?: (
      effect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Request.Only<"Error", R> | Request.Only<"GlobalError", R> | HttpServerError.HttpServerError,
        | Scope.Scope
        | HttpServerRequest.HttpServerRequest
        | Request.Only<"Requires", R>
        | Request.Only<"GlobalRequires", R>
      >
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HE, HR>
  }
): Layer.Layer<
  A,
  Request.Without<E>,
  HttpServer.HttpServer | Exclude<Request.Without<R> | Exclude<HR, GlobalProvided>, HttpRouter>
> => {
  let middleware: any = options?.middleware
  if (options?.disableLogger !== true) {
    middleware = middleware ? compose(middleware, HttpMiddleware.logger) : HttpMiddleware.logger
  }
  const RouterLayer = options?.routerConfig
    ? Layer.provide(layer, Layer.succeed(RouterConfig)(options.routerConfig))
    : layer
  return Effect.gen(function*() {
    const router = yield* HttpRouter
    const handler = router.asHttpEffect()
    return middleware ? HttpServer.serve(handler, middleware) : HttpServer.serve(handler)
  }).pipe(
    Layer.unwrap,
    Layer.provideMerge(appLayer),
    Layer.provide(RouterLayer),
    options?.disableListenLog ? identity : HttpServer.withLogAddress
  ) as any
}

/**
 * @since 4.0.0
 * @category Server
 */
export const toWebHandler = <
  A,
  E,
  R extends
    | HttpRouter
    | Request<"Requires", any>
    | Request<"GlobalRequires", any>
    | Request<"Error", any>
    | Request<"GlobalError", any>,
  HE,
  HR = Exclude<Request.Only<"Requires", R> | Request.Only<"GlobalRequires", R>, A>
>(
  appLayer: Layer.Layer<A, E, R>,
  options?: {
    readonly memoMap?: Layer.MemoMap | undefined
    readonly routerConfig?: Partial<FindMyWay.RouterConfig> | undefined
    readonly disableLogger?: boolean | undefined
    /**
     * Middleware to apply to the HTTP server.
     *
     * NOTE: This middleware is applied to the entire HTTP server chain,
     * including the sending of the response. This means that modifications
     * to the response **WILL NOT** be reflected in the final response sent to the
     * client.
     *
     * Use HttpRouter.middleware to create middleware that can modify the
     * response.
     */
    readonly middleware?: (
      effect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Request.Only<"Error", R> | Request.Only<"GlobalError", R> | HttpServerError.HttpServerError,
        | Scope.Scope
        | HttpServerRequest.HttpServerRequest
        | Request.Only<"Requires", R>
        | Request.Only<"GlobalRequires", R>
      >
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HE, HR>
  }
): {
  readonly handler: [HR] extends [never]
    ? ((request: globalThis.Request, context?: ServiceMap.ServiceMap<never> | undefined) => Promise<Response>)
    : ((request: globalThis.Request, context: ServiceMap.ServiceMap<HR>) => Promise<Response>)
  readonly dispose: () => Promise<void>
} => {
  let middleware: any = options?.middleware
  if (options?.disableLogger !== true) {
    middleware = middleware ? compose(middleware, HttpMiddleware.logger) : HttpMiddleware.logger
  }
  const RouterLayer = options?.routerConfig
    ? Layer.provide(layer, Layer.succeed(RouterConfig)(options.routerConfig))
    : layer
  return HttpEffect.toWebHandlerLayerWith(Layer.provideMerge(appLayer, RouterLayer) as Layer.Layer<A | HttpRouter, E>, {
    toHandler: (s) => Effect.succeed(ServiceMap.get(s, HttpRouter).asHttpEffect()),
    middleware,
    memoMap: options?.memoMap
  })
}
