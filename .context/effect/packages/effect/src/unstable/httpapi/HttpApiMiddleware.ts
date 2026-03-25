/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import { Scope } from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { unhandled } from "../../Types.ts"
import type * as HttpClientError from "../http/HttpClientError.ts"
import type * as HttpClientRequest from "../http/HttpClientRequest.ts"
import type * as HttpClientResponse from "../http/HttpClientResponse.ts"
import type * as HttpRouter from "../http/HttpRouter.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import type * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiSecurity from "./HttpApiSecurity.ts"

const TypeId = "~effect/httpapi/HttpApiMiddleware"

const SecurityTypeId = "~effect/httpapi/HttpApiMiddleware/Security"

/**
 * @since 4.0.0
 * @category guards
 */
export const isSecurity = (u: AnyService): u is AnyServiceSecurity => hasProperty(u, SecurityTypeId)

type ErrorConstraint = Schema.Top | ReadonlyArray<Schema.Top>

type ErrorSchemaFromConstraint<E> = E extends ReadonlyArray<Schema.Top> ? E[number]
  : E extends Schema.Top ? E
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type HttpApiMiddleware<Provides, E extends ErrorConstraint, Requires> = (
  httpEffect: Effect.Effect<HttpServerResponse, unhandled, Provides>,
  options: {
    readonly endpoint: HttpApiEndpoint.AnyWithProps
    readonly group: HttpApiGroup.AnyWithProps
  }
) => Effect.Effect<HttpServerResponse, unhandled | ErrorSchemaFromConstraint<E>["Type"], Requires | HttpRouter.Provided>

/**
 * @since 4.0.0
 * @category models
 */
export type HttpApiMiddlewareSecurity<
  Security extends Record<string, HttpApiSecurity.HttpApiSecurity>,
  Provides,
  E extends ErrorConstraint,
  Requires
> = {
  readonly [K in keyof Security]: (
    httpEffect: Effect.Effect<HttpServerResponse, unhandled, Provides>,
    options: {
      readonly credential: HttpApiSecurity.HttpApiSecurity.Type<Security[K]>
      readonly endpoint: HttpApiEndpoint.AnyWithProps
      readonly group: HttpApiGroup.AnyWithProps
    }
  ) => Effect.Effect<
    HttpServerResponse,
    unhandled | ErrorSchemaFromConstraint<E>["Type"],
    Requires | HttpRouter.Provided
  >
}

/**
 * @since 4.0.0
 * @category models
 */
export interface HttpApiMiddlewareClient<_E, CE, R> {
  (options: {
    readonly endpoint: HttpApiEndpoint.AnyWithProps
    readonly group: HttpApiGroup.AnyWithProps
    readonly request: HttpClientRequest.HttpClientRequest
    readonly next: (
      request: HttpClientRequest.HttpClientRequest
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
  }): Effect.Effect<HttpClientResponse.HttpClientResponse, CE | HttpClientError.HttpClientError, R>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface ForClient<Id> {
  readonly _: unique symbol
  readonly id: Id
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyService extends ServiceMap.Key<any, any> {
  readonly [TypeId]: typeof TypeId
  readonly provides: any
  readonly error: ReadonlySet<Schema.Top>
  readonly requiredForClient: boolean
  readonly "~ClientError": any
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyServiceSecurity extends AnyService {
  readonly [SecurityTypeId]: typeof SecurityTypeId
  readonly security: Record<string, HttpApiSecurity.HttpApiSecurity>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyId {
  readonly [TypeId]: {
    readonly provides: any
    readonly requires: any
    readonly error: ErrorConstraint
    readonly clientError: any
    readonly requiredForClient: boolean
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export type Provides<A> = A extends { readonly [TypeId]: { readonly provides: infer P } } ? P : never

/**
 * @since 4.0.0
 * @category models
 */
export type Requires<A> = A extends { readonly [TypeId]: { readonly requires: infer R } } ? R : never

/**
 * @since 4.0.0
 * @category models
 */
export type ApplyServices<A extends AnyId, R> = Exclude<R, Provides<A>> | Requires<A>

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorSchema<A> = A extends { readonly [TypeId]: { readonly error: infer E } } ? ErrorSchemaFromConstraint<E>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Error<A> = ErrorSchema<A>["Type"]

/**
 * @since 4.0.0
 * @category models
 */
export type ClientError<A> = A extends {
  readonly [TypeId]: {
    readonly clientError: infer CE
    readonly requiredForClient: true
  }
} ? CE
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareClient<A> = A extends {
  readonly [TypeId]: {
    readonly requiredForClient: true
  }
} ? ForClient<A>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorServicesEncode<A> = ErrorSchema<A>["EncodingServices"]

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorServicesDecode<A> = ErrorSchema<A>["DecodingServices"]

/**
 * @since 4.0.0
 * @category Schemas
 */
export type ServiceClass<
  Self,
  Id extends string,
  Config extends {
    requires: any
    provides: any
    error: ErrorConstraint
    clientError: any
    requiredForClient: boolean
    security: Record<string, HttpApiSecurity.HttpApiSecurity>
  },
  Service =
    ([Config["security"]] extends [never] ? HttpApiMiddleware<Config["provides"], Config["error"], Config["requires"]>
      : HttpApiMiddlewareSecurity<Config["security"], Config["provides"], Config["error"], Config["requires"]>)
> =
  & ServiceMap.Service<Self, Service>
  & {
    new(_: never): ServiceMap.ServiceClass.Shape<Id, Service> & {
      readonly [TypeId]: {
        readonly error: Config["error"]
        readonly requires: Config["requires"]
        readonly provides: Config["provides"]
        readonly clientError: Config["clientError"]
        readonly requiredForClient: Config["requiredForClient"]
      }
    }
    readonly [TypeId]: typeof TypeId
    readonly error: ReadonlySet<Schema.Top>
    readonly requiredForClient: Config["requiredForClient"]
    readonly "~ClientError": Config["clientError"]
  }
  & ([keyof Config["security"]] extends [never] ? {} : {
    readonly [SecurityTypeId]: typeof SecurityTypeId
    readonly security: Config["security"]
  })

/**
 * @since 4.0.0
 * @category Schemas
 */
export const Service = <
  Self,
  Config extends {
    requires?: any
    provides?: any
    clientError?: any
  } = { requires: never; provides: never; clientError: never }
>(): <
  const Id extends string,
  const Error extends ErrorConstraint = never,
  const Security extends Record<string, HttpApiSecurity.HttpApiSecurity> = never,
  RequiredForClient extends boolean = false
>(
  id: Id,
  options?: {
    readonly error?: Error | undefined
    readonly security?: Security | undefined
    readonly requiredForClient?: RequiredForClient | undefined
  } | undefined
) => ServiceClass<Self, Id, {
  requires: "requires" extends keyof Config ? Config["requires"] : never
  provides: "provides" extends keyof Config ? Config["provides"] : never
  error: Error
  clientError: "clientError" extends keyof Config ? Config["clientError"] : never
  requiredForClient: RequiredForClient
  security: Security
}> =>
(
  id: string,
  options?: {
    readonly security?: Record<string, HttpApiSecurity.HttpApiSecurity> | undefined
    readonly error?: ErrorConstraint | undefined
    readonly requiredForClient?: boolean | undefined
  } | undefined
) => {
  const Err = globalThis.Error as any
  const limit = Err.stackTraceLimit
  Err.stackTraceLimit = 2
  const creationError = new Err()
  Err.stackTraceLimit = limit

  class Service extends ServiceMap.Service<Self, any>()(id) {}
  const self = Service as any
  Object.defineProperty(Service, "stack", {
    get() {
      return creationError.stack
    }
  })
  self[TypeId] = TypeId
  self.error = getError(options?.error)
  self.requiredForClient = options?.requiredForClient ?? false
  if (options?.security !== undefined) {
    if (Object.keys(options.security).length === 0) {
      throw new Error("HttpApiMiddleware.Service: security object must not be empty")
    }
    self[SecurityTypeId] = SecurityTypeId
    self.security = options.security
  }
  return self
}

function getError(error: ErrorConstraint | undefined): ReadonlySet<Schema.Top> {
  if (error === undefined) return new Set()
  return new Set(Array.isArray(error) ? error : [error])
}

/**
 * Implement a middleware Layer that transforms `SchemaError`'s.
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { HttpApiMiddleware } from "effect/unstable/httpapi"
 *
 * export class CustomError extends Schema.TaggedErrorClass<CustomError>()("CustomError", {}) {}
 *
 * export class ErrorHandler extends HttpApiMiddleware.Service<ErrorHandler>()("api/ErrorHandler", {
 *   error: CustomError
 * }) {}
 *
 * export const ErrorHandlerLayer = HttpApiMiddleware.layerSchemaErrorTransform(
 *   ErrorHandler,
 *   (schemaError) =>
 *     Effect.log("Got SchemaError", schemaError).pipe(
 *       Effect.andThen(Effect.fail(new CustomError()))
 *     )
 * )
 * ```
 *
 * @since 4.0.0
 * @category SchemaError transform
 */
export const layerSchemaErrorTransform = <Id, E extends ErrorConstraint, Requires>(
  service: ServiceMap.Service<Id, HttpApiMiddleware<never, E, Requires>>,
  transform: (
    error: Schema.SchemaError,
    context: { readonly endpoint: HttpApiEndpoint.AnyWithProps; readonly group: HttpApiGroup.AnyWithProps }
  ) => Effect.Effect<
    HttpServerResponse,
    ErrorSchemaFromConstraint<E>["Type"] | Schema.SchemaError,
    Requires | HttpRouter.Provided
  >
): Layer.Layer<Id> =>
  Layer.succeed(
    service,
    (httpEffect, options) =>
      Effect.catch(
        httpEffect,
        (e): Effect.Effect<
          HttpServerResponse,
          unhandled | Schema.SchemaError | ErrorSchemaFromConstraint<E>["Type"],
          Requires | HttpRouter.Provided
        > => Schema.isSchemaError(e) ? transform(e, options) : Effect.fail(e)
      )
  )

/**
 * @since 4.0.0
 * @category client
 */
export const layerClient = <Id extends AnyId, S, R, EX = never, RX = never>(
  tag: ServiceMap.Key<Id, S>,
  service:
    | HttpApiMiddlewareClient<Error<Id>, Id[typeof TypeId]["clientError"], R>
    | Effect.Effect<
      HttpApiMiddlewareClient<Error<Id>, Id[typeof TypeId]["clientError"], R>,
      EX,
      RX
    >
): Layer.Layer<ForClient<Id>, EX, R | Exclude<RX, Scope>> =>
  Layer.effectServices(Effect.gen(function*() {
    const services = (yield* Effect.services<R | Scope>()).pipe(
      ServiceMap.omit(Scope)
    ) as ServiceMap.ServiceMap<R>
    const middleware = Effect.isEffect(service) ? yield* service : service
    return ServiceMap.makeUnsafe(
      new Map([[
        `${tag.key}/Client`,
        (options: any) =>
          Effect.updateServices(
            middleware(options),
            (requestContext) => ServiceMap.merge(services, requestContext)
          )
      ]])
    )
  }))
