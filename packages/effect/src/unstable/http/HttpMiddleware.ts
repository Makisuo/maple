/**
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Effect from "../../Effect.ts"
import { constant, constFalse } from "../../Function.ts"
import * as internalEffect from "../../internal/effect.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { Predicate } from "../../Predicate.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import { TracerEnabled } from "../../References.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import { ParentSpan } from "../../Tracer.ts"
import * as Headers from "./Headers.ts"
import { causeResponseStripped, exitResponse } from "./HttpServerError.ts"
import { HttpServerRequest } from "./HttpServerRequest.ts"
import * as Request from "./HttpServerRequest.ts"
import * as Response from "./HttpServerResponse.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"
import * as TraceContext from "./HttpTraceContext.ts"
import { appendPreResponseHandlerUnsafe } from "./internal/preResponseHandler.ts"

/**
 * @since 4.0.0
 * @category models
 */
export interface HttpMiddleware {
  <E, R>(self: Effect.Effect<HttpServerResponse, E, R | HttpServerRequest>): Effect.Effect<HttpServerResponse, any, any>
}

/**
 * @since 4.0.0
 */
export declare namespace HttpMiddleware {
  /**
   * @since 4.0.0
   */
  export interface Applied<A extends Effect.Effect<HttpServerResponse, any, any>, E, R> {
    (self: Effect.Effect<HttpServerResponse, E, R>): A
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <M extends HttpMiddleware>(middleware: M): M => middleware

const loggerDisabledRequests = new WeakSet<object>()

/**
 * @since 4.0.0
 * @category Logger
 */
export const withLoggerDisabled = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | HttpServerRequest> =>
  Effect.withFiber((fiber) => {
    const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
    loggerDisabledRequests.add(request.source)
    return self
  })

/**
 * @since 4.0.0
 * @category Tracer
 */
export const TracerDisabledWhen = ServiceMap.Reference<Predicate<HttpServerRequest>>(
  "effect/http/HttpMiddleware/TracerDisabledWhen",
  { defaultValue: () => constFalse }
)

/**
 * @since 4.0.0
 * @category Tracer
 */
export const layerTracerDisabledForUrls = (
  urls: ReadonlyArray<string>
): Layer.Layer<never> => Layer.succeed(TracerDisabledWhen)((req) => urls.includes(req.url))

/**
 * @since 4.0.0
 * @category Tracer
 */
export const SpanNameGenerator = ServiceMap.Reference<(request: HttpServerRequest) => string>(
  "@effect/platform/HttpMiddleware/SpanNameGenerator",
  { defaultValue: () => (request) => `http.server ${request.method}` }
)

/**
 * @since 4.0.0
 * @category Logger
 */
export const logger: <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, HttpServerRequest | R>
) => Effect.Effect<HttpServerResponse, E, HttpServerRequest | R> = make((httpApp) => {
  let counter = 0
  return Effect.withFiber((fiber) => {
    const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
    return Effect.withLogSpan(
      Effect.flatMap(Effect.exit(httpApp), (exit) => {
        if (loggerDisabledRequests.has(request.source)) {
          return exit
        } else if (exit._tag === "Failure") {
          const [response, cause] = causeResponseStripped(exit.cause)
          return Effect.andThen(
            Effect.annotateLogs(Effect.log(Option.getOrElse(cause, () => "Sent HTTP Response")), {
              "http.method": request.method,
              "http.url": request.url,
              "http.status": response.status
            }),
            exit
          )
        }
        return Effect.andThen(
          Effect.annotateLogs(Effect.log("Sent HTTP response"), {
            "http.method": request.method,
            "http.url": request.url,
            "http.status": exit.value.status
          }),
          exit
        )
      }),
      `http.span.${++counter}`
    )
  })
})

/**
 * @since 4.0.0
 * @category Tracer
 */
export const tracer: <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, HttpServerRequest | R>
) => Effect.Effect<HttpServerResponse, E, HttpServerRequest | R> = make((httpApp) =>
  Effect.withFiber((fiber) => {
    const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
    const disabled = !fiber.getRef(TracerEnabled) || fiber.getRef(TracerDisabledWhen)(request)
    if (disabled) {
      return httpApp
    }
    const nameGenerator = fiber.getRef(SpanNameGenerator)
    const span = internalEffect.makeSpanUnsafe(fiber, nameGenerator(request), {
      parent: Option.getOrUndefined(TraceContext.fromHeaders(request.headers)),
      kind: "server"
    })
    const prevServices = fiber.services
    fiber.setServices(ServiceMap.add(fiber.services, ParentSpan, span))
    return Effect.onExitPrimitive(httpApp, (exit) => {
      fiber.setServices(prevServices)
      const endTime = fiber.getRef(Clock).currentTimeNanosUnsafe()
      fiber.currentDispatcher.scheduleTask(() => {
        const url = Request.toURL(request)
        if (Option.isSome(url) && (url.value.username !== "" || url.value.password !== "")) {
          url.value.username = "REDACTED"
          url.value.password = "REDACTED"
        }
        const redactedHeaderNames = fiber.getRef(Headers.CurrentRedactedNames)
        const requestHeaders = Headers.redact(request.headers, redactedHeaderNames)
        span.attribute("http.request.method", request.method)
        if (Option.isSome(url)) {
          span.attribute("url.full", url.value.toString())
          span.attribute("url.path", url.value.pathname)
          const query = url.value.search.slice(1)
          if (query !== "") {
            span.attribute("url.query", url.value.search.slice(1))
          }
          span.attribute("url.scheme", url.value.protocol.slice(0, -1))
        }
        if (request.headers["user-agent"] !== undefined) {
          span.attribute("user_agent.original", request.headers["user-agent"])
        }
        for (const name in requestHeaders) {
          span.attribute(`http.request.header.${name}`, String(requestHeaders[name]))
        }
        if (Option.isSome(request.remoteAddress)) {
          span.attribute("client.address", request.remoteAddress.value)
        }
        const response = exitResponse(exit)
        span.attribute("http.response.status_code", response.status)
        const responseHeaders = Headers.redact(response.headers, redactedHeaderNames)
        for (const name in responseHeaders) {
          span.attribute(`http.response.header.${name}`, String(responseHeaders[name]))
        }
        span.end(endTime, exit)
      }, 0)
      return undefined
    }, true)
  })
)

/**
 * @since 4.0.0
 * @category Proxying
 */
export const xForwardedHeaders = make((httpApp) =>
  Effect.updateService(httpApp, HttpServerRequest, (request) =>
    request.headers["x-forwarded-host"]
      ? request.modify({
        headers: Headers.set(
          request.headers,
          "host",
          request.headers["x-forwarded-host"]
        ),
        remoteAddress: Option.fromNullishOr(request.headers["x-forwarded-for"]?.split(",")[0].trim())
      })
      : request)
)

/**
 * @since 4.0.0
 * @category Search params
 */
export const searchParamsParser = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, R>
): Effect.Effect<Response.HttpServerResponse, E, HttpServerRequest | Exclude<R, Request.ParsedSearchParams>> =>
  Effect.withFiber((fiber) => {
    const services = fiber.services
    const request = ServiceMap.getUnsafe(services, HttpServerRequest)
    const params = Request.searchParamsFromURL(new URL(request.originalUrl))
    return Effect.provideService(
      httpApp,
      Request.ParsedSearchParams,
      params
    ) as any
  })

/**
 * @since 4.0.0
 * @category CORS
 */
export const cors = (options?: {
  readonly allowedOrigins?: ReadonlyArray<string> | Predicate<string> | undefined
  readonly allowedMethods?: ReadonlyArray<string> | undefined
  readonly allowedHeaders?: ReadonlyArray<string> | undefined
  readonly exposedHeaders?: ReadonlyArray<string> | undefined
  readonly maxAge?: number | undefined
  readonly credentials?: boolean | undefined
}): <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, R>
) => Effect.Effect<HttpServerResponse, E, R | HttpServerRequest> => {
  const opts = {
    allowedOrigins: options?.allowedOrigins ?? [],
    allowedMethods: options?.allowedMethods ?? ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    allowedHeaders: options?.allowedHeaders ?? [],
    exposedHeaders: options?.exposedHeaders ?? [],
    credentials: options?.credentials ?? false,
    maxAge: options?.maxAge
  }

  const isAllowedOrigin = typeof opts.allowedOrigins === "function"
    ? opts.allowedOrigins
    : (origin: string) => (opts.allowedOrigins as ReadonlyArray<string>).includes(origin)

  const allowOrigin = typeof opts.allowedOrigins === "function" || opts.allowedOrigins.length > 1
    ? ((originHeader: string) => {
      if (!isAllowedOrigin(originHeader)) return undefined
      return {
        "access-control-allow-origin": originHeader,
        vary: "Origin"
      }
    })
    : opts.allowedOrigins.length === 0
    ? constant({
      "access-control-allow-origin": "*"
    })
    : constant({
      "access-control-allow-origin": opts.allowedOrigins[0],
      vary: "Origin"
    })

  const allowMethods = opts.allowedMethods.length > 0
    ? { "access-control-allow-methods": opts.allowedMethods.join(", ") }
    : undefined

  const allowCredentials = opts.credentials
    ? { "access-control-allow-credentials": "true" }
    : undefined

  const allowHeaders = (
    accessControlRequestHeaders: string | undefined
  ): ReadonlyRecord<string, string> | undefined => {
    if (opts.allowedHeaders.length === 0 && accessControlRequestHeaders) {
      return {
        vary: "Access-Control-Request-Headers",
        "access-control-allow-headers": accessControlRequestHeaders
      }
    }

    if (opts.allowedHeaders) {
      return {
        "access-control-allow-headers": opts.allowedHeaders.join(",")
      }
    }

    return undefined
  }

  const exposeHeaders = opts.exposedHeaders.length > 0
    ? { "access-control-expose-headers": opts.exposedHeaders.join(",") }
    : undefined

  const maxAge = opts.maxAge
    ? { "access-control-max-age": opts.maxAge.toString() }
    : undefined

  const headersFromRequest = (request: HttpServerRequest) => {
    const origin = request.headers["origin"]
    return Headers.fromRecordUnsafe({
      ...allowOrigin(origin),
      ...allowCredentials,
      ...exposeHeaders
    })
  }

  const headersFromRequestOptions = (request: HttpServerRequest) => {
    const origin = request.headers["origin"]
    const accessControlRequestHeaders = request.headers["access-control-request-headers"]
    return Headers.fromRecordUnsafe({
      ...allowOrigin(origin),
      ...allowCredentials,
      ...exposeHeaders,
      ...allowMethods,
      ...allowHeaders(accessControlRequestHeaders),
      ...maxAge
    })
  }

  const preResponseHandler = (request: HttpServerRequest, response: HttpServerResponse) =>
    Effect.succeed(Response.setHeaders(response, headersFromRequest(request)))

  return <E, R>(
    httpApp: Effect.Effect<HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse, E, R | HttpServerRequest> =>
    Effect.withFiber((fiber) => {
      const request = ServiceMap.getUnsafe(fiber.services, HttpServerRequest)
      if (request.method === "OPTIONS") {
        return Effect.succeed(Response.empty({
          status: 204,
          headers: headersFromRequestOptions(request)
        }))
      }
      appendPreResponseHandlerUnsafe(request, preResponseHandler)
      return httpApp
    })
}
