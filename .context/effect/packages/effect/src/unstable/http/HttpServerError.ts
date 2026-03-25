/**
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as ErrorReporter from "../../ErrorReporter.ts"
import type * as Exit from "../../Exit.ts"
import { constUndefined } from "../../Function.ts"
import * as Option from "../../Option.ts"
import { hasProperty } from "../../Predicate.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Request from "./HttpServerRequest.ts"
import * as Respondable from "./HttpServerRespondable.ts"
import * as Response from "./HttpServerResponse.ts"

const TypeId = "~effect/http/HttpServerError"

/**
 * @since 4.0.0
 * @category error
 */
export class HttpServerError extends Data.TaggedError("HttpServerError")<{
  readonly reason: HttpServerErrorReason
}> implements Respondable.Respondable {
  constructor(props: {
    readonly reason: HttpServerErrorReason
  }) {
    if ("cause" in props.reason) {
      super({
        ...props,
        cause: props.reason.cause
      } as any)
    } else {
      super(props)
    }
  }

  readonly [TypeId] = TypeId

  override stack = `${this.name}: ${this.message}`

  get request(): Request.HttpServerRequest {
    return this.reason.request
  }

  get response(): Response.HttpServerResponse | undefined {
    return "response" in this.reason ? this.reason.response : undefined
  }

  [Respondable.symbol]() {
    return this.reason[Respondable.symbol]()
  }

  override get [ErrorReporter.ignore](): boolean {
    return this.reason[ErrorReporter.ignore] ?? false
  }

  override get message(): string {
    return this.reason.message
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class RequestParseError extends Data.TaggedError("RequestParseError")<{
  readonly request: Request.HttpServerRequest
  readonly description?: string
  readonly cause?: unknown
}> implements Respondable.Respondable {
  /**
   * @since 4.0.0
   */
  [Respondable.symbol]() {
    return Effect.succeed(Response.empty({ status: 400 }))
  }

  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  override get message() {
    return formatRequestMessage(this._tag, this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class RouteNotFound extends Data.TaggedError("RouteNotFound")<{
  readonly request: Request.HttpServerRequest
  readonly description?: string
  readonly cause?: unknown
}> implements Respondable.Respondable {
  [Respondable.symbol]() {
    return Effect.succeed(Response.empty({ status: 404 }))
  }

  override readonly [ErrorReporter.ignore] = true

  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  override get message() {
    return formatRequestMessage(this._tag, this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export class InternalError extends Data.TaggedError("InternalError")<{
  readonly request: Request.HttpServerRequest
  readonly description?: string
  readonly cause?: unknown
}> implements Respondable.Respondable {
  /**
   * @since 4.0.0
   */
  [Respondable.symbol]() {
    return Effect.succeed(Response.empty({ status: 500 }))
  }

  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  override get message() {
    return formatRequestMessage(this._tag, this.description, this.methodAndUrl)
  }
}

/**
 * @since 4.0.0
 * @category predicates
 */
export const isHttpServerError = (u: unknown): u is HttpServerError => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category error
 */
export class ResponseError extends Data.TaggedError("ResponseError")<{
  readonly request: Request.HttpServerRequest
  readonly response: Response.HttpServerResponse
  readonly description?: string
  readonly cause?: unknown
}> implements Respondable.Respondable {
  [Respondable.symbol]() {
    return Effect.succeed(Response.empty({ status: 500 }))
  }

  get methodAndUrl() {
    return `${this.request.method} ${this.request.url}`
  }

  override get message() {
    const info = `${this._tag} (${this.response.status} ${this.methodAndUrl})`
    return this.description ? `${info}: ${this.description}` : info
  }
}

/**
 * @since 4.0.0
 * @category error
 */
export type RequestError = RequestParseError | RouteNotFound | InternalError

/**
 * @since 4.0.0
 * @category error
 */
export type HttpServerErrorReason = RequestError | ResponseError

/**
 * @since 4.0.0
 * @category error
 */
export class ServeError extends Data.TaggedError("ServeError")<{
  readonly cause: unknown
}> {}

/**
 * @since 4.0.0
 * @category Annotations
 */
export class ClientAbort extends ServiceMap.Service<ClientAbort, true>()("effect/http/HttpServerError/ClientAbort") {
  static annotation = this.serviceMap(true).pipe(
    ServiceMap.add(Cause.StackTrace, {
      name: "ClientAbort",
      stack: constUndefined,
      parent: undefined
    })
  )
}

const formatRequestMessage = (reason: string, description: string | undefined, info: string) => {
  const prefix = `${reason} (${info})`
  return description ? `${prefix}: ${description}` : prefix
}

/**
 * @since 4.0.0
 */
export const causeResponse = <E>(
  cause: Cause.Cause<E>
): Effect.Effect<readonly [Response.HttpServerResponse, Cause.Cause<E>]> => {
  let response: Response.HttpServerResponse | undefined
  let effect = succeedInternalServerError
  const failures: Array<Cause.Reason<E>> = []
  let interrupts: Array<Cause.Interrupt> = []
  let isClientInterrupt = false
  for (let i = 0; i < cause.reasons.length; i++) {
    const reason = cause.reasons[i]
    switch (reason._tag) {
      case "Fail": {
        effect = Respondable.toResponseOrElse(reason.error, internalServerError)
        failures.push(reason)
        break
      }
      case "Die": {
        if (Response.isHttpServerResponse(reason.defect)) {
          response = reason.defect
        } else {
          effect = Respondable.toResponseOrElseDefect(reason.defect, internalServerError)
          failures.push(reason)
        }
        break
      }
      case "Interrupt": {
        isClientInterrupt = reason.annotations.has(ClientAbort.key)
        if (failures.length > 0) break
        interrupts.push(reason)
        break
      }
    }
  }
  if (response) {
    return Effect.succeed([response, Cause.fromReasons(failures)] as const)
  } else if (interrupts.length > 0 && failures.length === 0) {
    failures.push(...interrupts)
    effect = isClientInterrupt ? clientAbortError : serverAbortError
  }
  return Effect.mapEager(effect, (response) => {
    failures.push(Cause.makeDieReason(response))
    return [response, Cause.fromReasons(failures)] as const
  })
}

/**
 * @since 4.0.0
 */
export const causeResponseStripped = <E>(
  cause: Cause.Cause<E>
): readonly [response: Response.HttpServerResponse, cause: Option.Option<Cause.Cause<E>>] => {
  let response: Response.HttpServerResponse | undefined
  const failures = cause.reasons.filter((f) => {
    if (f._tag === "Die" && Response.isHttpServerResponse(f.defect)) {
      response = f.defect
      return false
    }
    return true
  })
  return [
    response ?? internalServerError,
    failures.length > 0 ? Option.some(Cause.fromReasons(failures)) : Option.none()
  ]
}

const internalServerError = Response.empty({ status: 500 })
const succeedInternalServerError = Effect.succeed(internalServerError)
const clientAbortError = Effect.succeed(Response.empty({ status: 499 }))
const serverAbortError = Effect.succeed(Response.empty({ status: 503 }))

/**
 * @since 4.0.0
 */
export const exitResponse = <E>(exit: Exit.Exit<Response.HttpServerResponse, E>): Response.HttpServerResponse => {
  if (exit._tag === "Success") {
    return exit.value
  }
  return causeResponseStripped(exit.cause)[0]
}
