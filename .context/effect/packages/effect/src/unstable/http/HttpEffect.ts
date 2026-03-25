/**
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { dual } from "../../Function.ts"
import { reportCauseUnsafe } from "../../internal/effect.ts"
import * as Layer from "../../Layer.ts"
import * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as HttpBody from "./HttpBody.ts"
import { type HttpMiddleware, tracer } from "./HttpMiddleware.ts"
import { causeResponse, ClientAbort, HttpServerError, InternalError } from "./HttpServerError.ts"
import { HttpServerRequest } from "./HttpServerRequest.ts"
import * as Request from "./HttpServerRequest.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"
import * as Response from "./HttpServerResponse.ts"
import { appendPreResponseHandlerUnsafe, requestPreResponseHandlers } from "./internal/preResponseHandler.ts"

/**
 * @since 4.0.0
 * @category combinators
 */
export const toHandled = <E, R, EH, RH>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  handleResponse: (
    request: HttpServerRequest,
    response: HttpServerResponse
  ) => Effect.Effect<unknown, EH, RH>,
  middleware?: HttpMiddleware | undefined
): Effect.Effect<void, never, Exclude<R | RH | HttpServerRequest, Scope.Scope>> => {
  const handleCause = (cause: Cause.Cause<E | EH | HttpServerError>) =>
    Effect.flatMapEager(causeResponse(cause), ([response, cause]) => {
      const fiber = Fiber.getCurrent()!
      reportCauseUnsafe(fiber, cause)
      const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
      const handler = requestPreResponseHandlers.get(request.source)
      const cont = cause.reasons.length === 0 ? Effect.succeed(response) : Effect.failCause(cause)
      if (handler === undefined) {
        ;(request as any)[handledSymbol] = true
        return Effect.flatMapEager(
          handleResponse(request, response),
          () => cont
        )
      }

      return Effect.flatMapEager(
        Effect.flatMapEager(handler(request, response), (response) => {
          ;(request as any)[handledSymbol] = true
          return handleResponse(request, response)
        }),
        () => cont
      )
    })

  const responded = Effect.matchCauseEffect(self, {
    onSuccess: (response) => {
      const fiber = Fiber.getCurrent()!
      const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
      const handler = requestPreResponseHandlers.get(request.source)
      if (handler === undefined) {
        ;(request as any)[handledSymbol] = true
        return Effect.mapEager(handleResponse(request, response), () => response)
      }
      return Effect.flatMapEager(handler(request, response), (sentResponse) => {
        ;(request as any)[handledSymbol] = true
        return Effect.mapEager(handleResponse(request, sentResponse), () => response)
      })
    },
    onFailure: handleCause
  })

  const withMiddleware: Effect.Effect<
    unknown,
    E | EH | HttpServerError,
    HttpServerRequest | R | RH
  > = middleware === undefined ?
    tracer(responded) :
    Effect.matchCauseEffect(tracer(middleware(responded)), {
      onFailure(cause): Effect.Effect<void, EH, RH> {
        const fiber = Fiber.getCurrent()!
        reportCauseUnsafe(fiber, cause)
        const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
        if (handledSymbol in request) return Effect.void
        return Effect.matchCauseEffectEager(causeResponse(cause), {
          onFailure(_) {
            return handleResponse(request, Response.empty({ status: 500 }))
          },
          onSuccess([response]) {
            return handleResponse(request, response)
          }
        })
      },
      onSuccess(response): Effect.Effect<void, EH, RH> {
        const fiber = Fiber.getCurrent()!
        const request = ServiceMap.getUnsafe(fiber.services, Request.HttpServerRequest)
        return handledSymbol in request ? Effect.void : handleResponse(request, response)
      }
    })

  return Effect.uninterruptible(scoped(withMiddleware)) as any
}

const handledSymbol = Symbol.for("effect/http/HttpEffect/handled")

/**
 * If you want to finalize the http request scope elsewhere, you can use this
 * function to eject from the default scope closure.
 *
 * @since 4.0.0
 * @category Scope
 */
export const scopeDisableClose = (scope: Scope.Scope): void => {
  ;(scope as any)[scopeEjected] = true
}

/**
 * @since 4.0.0
 * @category Scope
 */
export const scopeTransferToStream = (
  response: HttpServerResponse
): HttpServerResponse => {
  if (response.body._tag !== "Stream") {
    return response
  }
  const fiber = Fiber.getCurrent()!
  const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope) as Scope.Closeable
  scopeDisableClose(scope)
  return Response.setBody(
    response,
    HttpBody.stream(
      Stream.onExit(response.body.stream, (exit) => Scope.close(scope, exit)),
      response.body.contentType,
      response.body.contentLength
    )
  )
}

const scopeEjected = Symbol.for("effect/http/HttpEffect/scopeEjected")

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.withFiber((fiber) => {
    const scope = Scope.makeUnsafe()
    const prevServices = fiber.services
    fiber.setServices(ServiceMap.add(fiber.services, Scope.Scope, scope))
    return Effect.onExitPrimitive(effect, (exit) => {
      fiber.setServices(prevServices)
      if (scopeEjected in scope) return undefined
      return Scope.closeUnsafe(scope, exit)
    }, true)
  })

/**
 * @since 4.0.0
 * @category Pre-response handlers
 */
export type PreResponseHandler = (
  request: HttpServerRequest,
  response: HttpServerResponse
) => Effect.Effect<HttpServerResponse, HttpServerError>

/**
 * @since 4.0.0
 * @category fiber refs
 */
export const appendPreResponseHandler = (handler: PreResponseHandler): Effect.Effect<void, never, HttpServerRequest> =>
  HttpServerRequest.use((request) => {
    appendPreResponseHandlerUnsafe(request, handler)
    return Effect.void
  })

export {
  /**
   * @since 4.0.0
   * @category fiber refs
   */
  appendPreResponseHandlerUnsafe
}

/**
 * @since 4.0.0
 * @category fiber refs
 */
export const withPreResponseHandler: {
  (handler: PreResponseHandler): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | HttpServerRequest>
  <A, E, R>(self: Effect.Effect<A, E, R>, handler: PreResponseHandler): Effect.Effect<A, E, R | HttpServerRequest>
} = dual<
  (
    handler: PreResponseHandler
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | HttpServerRequest>,
  <A, E, R>(self: Effect.Effect<A, E, R>, handler: PreResponseHandler) => Effect.Effect<A, E, R | HttpServerRequest>
>(2, (self, handler) =>
  HttpServerRequest.use((request) => {
    appendPreResponseHandlerUnsafe(request, handler)
    return self
  }))

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWebHandlerWith = <Provided, R = never, ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>>(
  services: ServiceMap.ServiceMap<Provided>
) =>
<E>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: HttpMiddleware | undefined
): [ReqR] extends [never] ?
  (request: Request, services?: ServiceMap.ServiceMap<never> | undefined) => Promise<globalThis.Response>
  : (request: Request, services: ServiceMap.ServiceMap<ReqR>) => Promise<globalThis.Response> =>
{
  const resolveSymbol = Symbol.for("@effect/platform/HttpApp/resolve")
  const httpApp = toHandled(self, (request, response) => {
    response = scopeTransferToStream(response)
    ;(request as any)[resolveSymbol](
      Response.toWeb(response, { withoutBody: request.method === "HEAD", services })
    )
    return Effect.void
  }, middleware)
  return (request: Request, reqServices?: ServiceMap.ServiceMap<never> | undefined): Promise<globalThis.Response> =>
    new Promise((resolve) => {
      const contextMap = new Map<string, any>(services.mapUnsafe)
      if (ServiceMap.isServiceMap(reqServices)) {
        for (const [key, value] of reqServices.mapUnsafe) {
          contextMap.set(key, value)
        }
      }
      const httpServerRequest = Request.fromWeb(request)
      contextMap.set(HttpServerRequest.key, httpServerRequest)
      ;(httpServerRequest as any)[resolveSymbol] = resolve
      const fiber = Effect.runForkWith(ServiceMap.makeUnsafe(contextMap))(httpApp as any)
      request.signal?.addEventListener("abort", () => {
        fiber.interruptUnsafe(undefined, ClientAbort.annotation)
      }, { once: true })
    })
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWebHandler: <E>(
  self: Effect.Effect<HttpServerResponse, E, HttpServerRequest | Scope.Scope>,
  middleware?: HttpMiddleware | undefined
) => (request: Request, services?: ServiceMap.ServiceMap<never> | undefined) => Promise<globalThis.Response> =
  toWebHandlerWith(ServiceMap.empty())

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWebHandlerLayerWith = <
  E,
  Provided,
  LE,
  R,
  ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>
>(
  layer: Layer.Layer<Provided, LE>,
  options: {
    readonly toHandler: (
      services: ServiceMap.ServiceMap<Provided>
    ) => Effect.Effect<Effect.Effect<HttpServerResponse, E, R>, LE>
    readonly middleware?: HttpMiddleware | undefined
    readonly memoMap?: Layer.MemoMap | undefined
  }
): {
  readonly dispose: () => Promise<void>
  readonly handler: [ReqR] extends [never] ? (
      request: Request,
      services?: ServiceMap.ServiceMap<never> | undefined
    ) => Promise<globalThis.Response>
    : (
      request: Request,
      services: ServiceMap.ServiceMap<ReqR>
    ) => Promise<globalThis.Response>
} => {
  const scope = Scope.makeUnsafe()
  const dispose = () => Effect.runPromise(Scope.close(scope, Exit.void))

  let handlerCache:
    | ((request: Request, services?: ServiceMap.ServiceMap<ReqR> | undefined) => Promise<globalThis.Response>)
    | undefined
  let handlerPromise:
    | Promise<(request: Request, services?: ServiceMap.ServiceMap<ReqR> | undefined) => Promise<globalThis.Response>>
    | undefined
  function handler(
    request: Request,
    services?: ServiceMap.ServiceMap<ReqR> | undefined
  ): Promise<globalThis.Response> {
    if (handlerCache) {
      return handlerCache(request, services)
    }
    handlerPromise ??= Effect.runPromise(Effect.gen(function*() {
      const services = yield* (options.memoMap
        ? Layer.buildWithMemoMap(layer, options.memoMap, scope)
        : Layer.buildWithScope(layer, scope))
      return handlerCache = toWebHandlerWith<Provided, R>(services)(
        yield* options.toHandler(services),
        options.middleware
      ) as any
    }))
    return handlerPromise.then((f) => f(request, services))
  }
  return { dispose, handler: handler as any } as const
}

/**
 * @since 4.0.0
 * @category conversions
 */
export const toWebHandlerLayer = <E, R, Provided, LE, ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  layer: Layer.Layer<Provided, LE>,
  options?: {
    readonly middleware?: HttpMiddleware | undefined
    readonly memoMap?: Layer.MemoMap | undefined
  } | undefined
): {
  readonly dispose: () => Promise<void>
  readonly handler: [ReqR] extends [never]
    ? (request: Request, services?: ServiceMap.ServiceMap<never> | undefined) => Promise<globalThis.Response>
    : (
      request: Request,
      services: ServiceMap.ServiceMap<ReqR>
    ) => Promise<globalThis.Response>
} =>
  toWebHandlerLayerWith(layer, {
    ...options,
    toHandler: () => Effect.succeed(self)
  })

/**
 * @since 4.0.0
 * @category conversions
 */
export const fromWebHandler = (
  handler: (request: Request) => Promise<Response>
): Effect.Effect<HttpServerResponse, HttpServerError, HttpServerRequest> =>
  Effect.callback((resume, signal) => {
    const fiber = Fiber.getCurrent()!
    const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
    const requestResult = Request.toWebResult(request, {
      signal,
      services: fiber.services
    })
    if (requestResult._tag === "Failure") {
      return resume(Effect.fail(new HttpServerError({ reason: requestResult.failure })))
    }
    handler(requestResult.success).then(
      (response) => resume(Effect.succeed(Response.fromWeb(response))),
      (cause) =>
        resume(Effect.fail(
          new HttpServerError({
            reason: new InternalError({
              cause,
              request,
              description: "HttpApp.fromWebHandler: Error in handler"
            })
          })
        ))
    )
  })
