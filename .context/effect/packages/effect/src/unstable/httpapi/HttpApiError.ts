/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as ErrorReporter from "../../ErrorReporter.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as HttpServerRespondable from "../http/HttpServerRespondable.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

const badRequestResponse = HttpServerResponse.empty({ status: 400 })
const unauthorizedResponse = HttpServerResponse.empty({ status: 401 })
const forbiddenResponse = HttpServerResponse.empty({ status: 403 })
const notFoundResponse = HttpServerResponse.empty({ status: 404 })
const methodNotAllowedResponse = HttpServerResponse.empty({ status: 405 })
const notAcceptableResponse = HttpServerResponse.empty({ status: 406 })
const requestTimeoutResponse = HttpServerResponse.empty({ status: 408 })
const conflictResponse = HttpServerResponse.empty({ status: 409 })
const goneResponse = HttpServerResponse.empty({ status: 410 })
const internalServerErrorResponse = HttpServerResponse.empty({ status: 500 })
const notImplementedResponse = HttpServerResponse.empty({ status: 501 })
const serviceUnavailableResponse = HttpServerResponse.empty({ status: 503 })

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class BadRequest extends Schema.ErrorClass<BadRequest>("effect/HttpApiError/BadRequest")({
  _tag: Schema.tag("BadRequest")
}, {
  description: "BadRequest",
  httpApiStatus: 400
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(badRequestResponse)
  }
  static readonly singleton = new BadRequest()
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const BadRequestNoContent = BadRequest.pipe(HttpApiSchema.asNoContent({
  decode: () => new BadRequest({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class Unauthorized extends Schema.ErrorClass<Unauthorized>("effect/HttpApiError/Unauthorized")({
  _tag: Schema.tag("Unauthorized")
}, {
  description: "Unauthorized",
  httpApiStatus: 401
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(unauthorizedResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const UnauthorizedNoContent = Unauthorized.pipe(HttpApiSchema.asNoContent({
  decode: () => new Unauthorized({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class Forbidden extends Schema.ErrorClass<Forbidden>("effect/HttpApiError/Forbidden")({
  _tag: Schema.tag("Forbidden")
}, {
  description: "Forbidden",
  httpApiStatus: 403
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(forbiddenResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const ForbiddenNoContent = Forbidden.pipe(HttpApiSchema.asNoContent({
  decode: () => new Forbidden({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class NotFound extends Schema.ErrorClass<NotFound>("effect/HttpApiError/NotFound")({
  _tag: Schema.tag("NotFound")
}, {
  description: "NotFound",
  httpApiStatus: 404
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(notFoundResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const NotFoundNoContent = NotFound.pipe(HttpApiSchema.asNoContent({
  decode: () => new NotFound({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class MethodNotAllowed extends Schema.ErrorClass<MethodNotAllowed>("effect/HttpApiError/MethodNotAllowed")({
  _tag: Schema.tag("MethodNotAllowed")
}, {
  description: "MethodNotAllowed",
  httpApiStatus: 405
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(methodNotAllowedResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const MethodNotAllowedNoContent = MethodNotAllowed.pipe(HttpApiSchema.asNoContent({
  decode: () => new MethodNotAllowed({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class NotAcceptable extends Schema.ErrorClass<NotAcceptable>("effect/HttpApiError/NotAcceptable")({
  _tag: Schema.tag("NotAcceptable")
}, {
  description: "NotAcceptable",
  httpApiStatus: 406
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(notAcceptableResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const NotAcceptableNoContent = NotAcceptable.pipe(HttpApiSchema.asNoContent({
  decode: () => new NotAcceptable({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class RequestTimeout extends Schema.ErrorClass<RequestTimeout>("effect/HttpApiError/RequestTimeout")({
  _tag: Schema.tag("RequestTimeout")
}, {
  description: "RequestTimeout",
  httpApiStatus: 408
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(requestTimeoutResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const RequestTimeoutNoContent = RequestTimeout.pipe(HttpApiSchema.asNoContent({
  decode: () => new RequestTimeout({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class Conflict extends Schema.ErrorClass<Conflict>("effect/HttpApiError/Conflict")({
  _tag: Schema.tag("Conflict")
}, {
  description: "Conflict",
  httpApiStatus: 409
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(conflictResponse)
  }
}

/**
 * @since 4.0.0
 * @category NoContent errors
 */
export const ConflictNoContent = Conflict.pipe(HttpApiSchema.asNoContent({
  decode: () => new Conflict({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class Gone extends Schema.ErrorClass<Gone>("effect/HttpApiError/Gone")({
  _tag: Schema.tag("Gone")
}, {
  description: "Gone",
  httpApiStatus: 410
}) {
  override readonly [ErrorReporter.ignore] = true;
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(goneResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const GoneNoContent = Gone.pipe(HttpApiSchema.asNoContent({
  decode: () => new Gone({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class InternalServerError
  extends Schema.ErrorClass<InternalServerError>("effect/HttpApiError/InternalServerError")({
    _tag: Schema.tag("InternalServerError")
  }, {
    description: "InternalServerError",
    httpApiStatus: 500
  })
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(internalServerErrorResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const InternalServerErrorNoContent = InternalServerError.pipe(HttpApiSchema.asNoContent({
  decode: () => new InternalServerError({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class NotImplemented extends Schema.ErrorClass<NotImplemented>("effect/HttpApiError/NotImplemented")({
  _tag: Schema.tag("NotImplemented")
}, {
  description: "NotImplemented",
  httpApiStatus: 501
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(notImplementedResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const NotImplementedNoContent = NotImplemented.pipe(HttpApiSchema.asNoContent({
  decode: () => new NotImplemented({})
}))

/**
 * @category Built-in errors
 * @since 4.0.0
 */
export class ServiceUnavailable
  extends Schema.ErrorClass<ServiceUnavailable>("effect/HttpApiError/ServiceUnavailable")({
    _tag: Schema.tag("ServiceUnavailable")
  }, {
    description: "ServiceUnavailable",
    httpApiStatus: 503
  })
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(serviceUnavailableResponse)
  }
}

/**
 * @category NoContent errors
 * @since 4.0.0
 */
export const ServiceUnavailableNoContent = ServiceUnavailable.pipe(HttpApiSchema.asNoContent({
  decode: () => new ServiceUnavailable({})
}))

/**
 * @category Parsing errors
 * @since 4.0.0
 */
export type HttpApiSchemaErrorTypeId = "~effect/httpapi/HttpApiError/HttpApiSchemaError"

/**
 * @category Parsing errors
 * @since 4.0.0
 */
export const HttpApiSchemaErrorTypeId: HttpApiSchemaErrorTypeId = "~effect/httpapi/HttpApiError/HttpApiSchemaError"

/**
 * @category Parsing errors
 * @since 4.0.0
 */
export class HttpApiSchemaError extends Data.TaggedClass("HttpApiSchemaError")<{
  readonly kind: "Params" | "Headers" | "Query" | "Body" | "Payload"
  readonly cause: Schema.SchemaError
}> {
  readonly [HttpApiSchemaErrorTypeId]: HttpApiSchemaErrorTypeId = HttpApiSchemaErrorTypeId

  static is(u: unknown): u is HttpApiSchemaError {
    return hasProperty(u, HttpApiSchemaErrorTypeId)
  }

  static wrap<A, R>(
    kind: HttpApiSchemaError["kind"],
    effect: Effect.Effect<A, Schema.SchemaError, R>
  ): Effect.Effect<A, HttpApiSchemaError, R> {
    return Effect.mapError(effect, (error) => new HttpApiSchemaError({ kind, cause: error }))
  }

  readonly name = "HttpApiSchemaError"
  readonly message = this.kind;

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(badRequestResponse)
  }
}
