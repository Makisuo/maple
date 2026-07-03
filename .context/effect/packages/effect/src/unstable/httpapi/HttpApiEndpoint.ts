/**
 * Defines endpoint declarations used inside an HTTP API group.
 *
 * An endpoint records a stable name, HTTP method, router path, request schemas,
 * response schemas, declared errors, middleware, and annotations. Endpoint
 * values are declarations, not handlers: builders use them to decode requests,
 * type handler input, encode responses, generate OpenAPI metadata, and derive
 * generated-client call signatures. This module also includes HTTP method
 * constructors, payload and response schema helpers, and type utilities used by
 * builders and generated clients.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type { Brand } from "../../Brand.ts"
import * as Context from "../../Context.ts"
import type { Effect } from "../../Effect.ts"
import { identity } from "../../Function.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import type * as Stream from "../../Stream.ts"
import type * as Types from "../../Types.ts"
import type { HttpMethod } from "../http/HttpMethod.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import type { HttpServerRequest } from "../http/HttpServerRequest.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import type * as Multipart from "../http/Multipart.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

const TypeId = "~effect/httpapi/HttpApiEndpoint"

/**
 * Returns `true` when a value is an `HttpApiEndpoint`, narrowing the value to the
 * endpoint interface.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpApiEndpoint = (u: unknown): u is HttpApiEndpoint<any, any, any> => Predicate.hasProperty(u, TypeId)

/**
 * Maps content types to the payload encoding strategy and one or more schemas that
 * can decode or encode payloads for that content type.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadMap = ReadonlyMap<string, {
  readonly encoding: HttpApiSchema.PayloadEncoding
  readonly schemas: [Schema.Top, ...Array<Schema.Top>]
}>

type SuccessType<S> = S extends HttpApiSchema.StreamSse<
  infer _Events,
  infer _Error,
  infer _Value
> ? Stream.Stream<_Value, _Error["Type"], never>
  : S extends HttpApiSchema.StreamUint8Array ? Stream.Stream<Uint8Array, unknown, never>
  : S extends Schema.Constraint ? S["Type"]
  : never

type SuccessEncodingServices<S> = S extends HttpApiSchema.StreamSse<
  infer _Events,
  infer _Error,
  infer _Value
> ? _Events["EncodingServices"] | _Error["EncodingServices"]
  : S extends HttpApiSchema.StreamUint8Array ? never
  : S extends Schema.Constraint ? S["EncodingServices"]
  : never

type SuccessDecodingServices<S> = S extends HttpApiSchema.StreamSse<
  infer _Events,
  infer _Error,
  infer _Value
> ? _Events["DecodingServices"] | _Error["DecodingServices"]
  : S extends HttpApiSchema.StreamUint8Array ? never
  : S extends Schema.Constraint ? S["DecodingServices"]
  : never

type ExtractSuccessOrArray<S extends SuccessConstraint> = S extends ReadonlyArray<Schema.Constraint> ? S[number] : S

type ExtractBufferedSuccess<S extends SuccessConstraint> = Exclude<
  Extract<ExtractSuccessOrArray<S>, Schema.Top>,
  HttpApiSchema.StreamSchema
>

type ExtractStreamSuccess<S extends SuccessConstraint> = ExtractSuccessOrArray<S> extends infer Success ?
  Success extends HttpApiSchema.StreamSchema ? Success : never
  : never

type JsonSuccessOrArray<S extends SuccessConstraint> = [ExtractBufferedSuccess<S>] extends [never] ?
  ExtractStreamSuccess<S>
  : Json<ExtractBufferedSuccess<S>> | ExtractStreamSuccess<S>

/**
 * Represents an API endpoint. An API endpoint is mapped to a single route on
 * the underlying `HttpRouter`.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpApiEndpoint<
  out Name extends string,
  out Method extends HttpMethod,
  out Path extends string,
  out Params extends Schema.Top = never,
  out Query extends Schema.Top = never,
  out Payload extends Schema.Top = never,
  out Headers extends Schema.Top = never,
  out Success extends Schema.Top = typeof HttpApiSchema.NoContent,
  out Error extends Schema.Top = never,
  in out Middleware = never,
  out MiddlewareR = never
> extends Pipeable {
  readonly [TypeId]: {
    readonly _MiddlewareR: Types.Covariant<MiddlewareR>
  }
  readonly "~Params": Params
  readonly "~Query": Query
  readonly "~Headers": Headers
  readonly "~Payload": Payload
  readonly "~Success": Success
  readonly "~Error": Error

  readonly name: Name
  readonly path: Path
  readonly method: Method
  readonly params: Schema.Top | undefined
  readonly query: Schema.Top | undefined
  readonly headers: Schema.Top | undefined
  readonly payload: PayloadMap
  readonly success: ReadonlySet<Schema.Top>
  readonly error: ReadonlySet<Schema.Top>
  readonly annotations: Context.Context<never>
  readonly middlewares: ReadonlySet<Context.Key<Middleware, any>>

  /**
   * Add a prefix to the path of the endpoint.
   */
  prefix<const Prefix extends HttpRouter.PathInput>(
    prefix: Prefix
  ): HttpApiEndpoint<
    Name,
    Method,
    `${Prefix}${Path}`,
    Params,
    Query,
    Payload,
    Headers,
    Success,
    Error,
    Middleware,
    MiddlewareR
  >

  /**
   * Add an `HttpApiMiddleware` to the endpoint.
   */
  middleware<I extends HttpApiMiddleware.AnyId, S>(middleware: Context.Key<I, S>): HttpApiEndpoint<
    Name,
    Method,
    Path,
    Params,
    Query,
    Payload,
    Headers,
    Success,
    Error,
    Middleware | I,
    HttpApiMiddleware.ApplyServices<I, MiddlewareR>
  >

  /**
   * Add an annotation on the endpoint.
   */
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: Types.NoInfer<S>
  ): HttpApiEndpoint<
    Name,
    Method,
    Path,
    Params,
    Query,
    Payload,
    Headers,
    Success,
    Error,
    Middleware,
    MiddlewareR
  >

  /**
   * Merge the annotations of the endpoint with the provided context.
   */
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): HttpApiEndpoint<
    Name,
    Method,
    Path,
    Params,
    Query,
    Payload,
    Headers,
    Success,
    Error,
    Middleware,
    MiddlewareR
  >
}

/** @internal */
export function getPayloadSchemas(endpoint: AnyWithProps): Array<Schema.Top> {
  const result: Array<Schema.Top> = []
  for (const { schemas } of endpoint.payload.values()) {
    result.push(...schemas)
  }
  return result
}

/** @internal */
export function getSuccessSchemas(endpoint: AnyWithProps): [Schema.Top, ...Array<Schema.Top>] {
  const schemas = Array.from(endpoint.success)
  return Arr.isArrayNonEmpty(schemas) ? schemas : [HttpApiSchema.NoContent]
}

/** @internal */
export function getErrorSchemas(endpoint: AnyWithProps): Array<Schema.Top> {
  const schemas = new Set<Schema.Top>(endpoint.error)
  for (const middleware of endpoint.middlewares) {
    const key = middleware as any as HttpApiMiddleware.AnyService
    for (const schema of key.error) {
      schemas.add(schema)
    }
  }
  return Array.from(schemas)
}

/**
 * A widened `HttpApiEndpoint` type used when the concrete method, path, schemas,
 * and middleware types are not needed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any extends Pipeable {
  readonly [TypeId]: any
  readonly name: string
  readonly ["~Success"]: Schema.Top
  readonly ["~Error"]: Schema.Top
}

/**
 * A widened endpoint type that preserves concrete runtime properties such as
 * method, path, schemas, annotations, and middleware sets.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyWithProps extends
  HttpApiEndpoint<
    string,
    HttpMethod,
    string,
    Schema.Top,
    Schema.Top,
    Schema.Top,
    Schema.Top,
    any,
    any
  >
{}

/**
 * Extracts the name literal from an `HttpApiEndpoint`.
 *
 * @category models
 * @since 4.0.0
 */
export type Name<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Name
  : never

/**
 * Extracts the success schema associated with an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type Success<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Success
  : never

/**
 * Extracts the error schema associated with an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type Error<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Error
  : never

/**
 * Extracts the schema used for an endpoint's path parameters.
 *
 * @category models
 * @since 4.0.0
 */
export type Params<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Params
  : never

/**
 * Extracts the schema used for an endpoint's query parameters.
 *
 * @category models
 * @since 4.0.0
 */
export type Query<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Query
  : never

/**
 * Extracts the schema used for an endpoint's request payload.
 *
 * @category models
 * @since 4.0.0
 */
export type Payload<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Payload
  : never

/**
 * Extracts the schema used for an endpoint's request headers.
 *
 * @category models
 * @since 4.0.0
 */
export type Headers<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Headers
  : never

/**
 * Extracts the middleware identifiers attached to an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type Middleware<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _M
  : never

/**
 * Computes the services provided by the middleware attached to an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareProvides<Endpoint extends Any> = HttpApiMiddleware.Provides<Middleware<Endpoint>>

/**
 * Computes the client-side middleware services required by an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareClient<Endpoint extends Any> = HttpApiMiddleware.MiddlewareClient<Middleware<Endpoint>>

/**
 * Computes the error types that can be produced by the middleware attached to an
 * endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareError<Endpoint extends Any> = HttpApiMiddleware.Error<Middleware<Endpoint>>

/**
 * Computes the full error value union for an endpoint, including the endpoint
 * error schema's type and errors introduced by middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type Errors<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Error["Type"] | HttpApiMiddleware.Error<Middleware<Endpoint>>
  : never

/**
 * Computes the services required to encode an endpoint's error responses,
 * including services required by middleware error encoders.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesEncode<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Error["EncodingServices"] | HttpApiMiddleware.ErrorServicesEncode<Middleware<Endpoint>>
  : never

/**
 * Builds the decoded request shape passed to a normal endpoint handler, including
 * available params, query, payload, headers, the raw request, endpoint, and group.
 * Multipart stream payloads are exposed as streams of parts.
 *
 * @category models
 * @since 4.0.0
 */
export type Request<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ?
    & ([_Params["Type"]] extends [never] ? {} : { readonly params: _Params["Type"] })
    & ([_Query["Type"]] extends [never] ? {} : { readonly query: _Query["Type"] })
    & ([_Payload["Type"]] extends [never] ? {}
      : _Payload["Type"] extends Brand<HttpApiSchema.MultipartStreamTypeId> ?
        { readonly payload: Stream.Stream<Multipart.Part, Multipart.MultipartError> }
      : { readonly payload: _Payload["Type"] })
    & ([_Headers] extends [never] ? {} : { readonly headers: _Headers["Type"] })
    & {
      readonly request: HttpServerRequest
      readonly endpoint: Endpoint
      readonly group: HttpApiGroup.AnyWithProps
    }
  : {}

/**
 * Builds the request shape passed to a raw endpoint handler, including decoded
 * params, query, and headers plus the raw request, endpoint, and group, while
 * leaving payload handling to the raw request.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestRaw<Endpoint extends Any> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ?
    & ([_Params["Type"]] extends [never] ? {} : { readonly params: _Params["Type"] })
    & ([_Query["Type"]] extends [never] ? {} : { readonly query: _Query["Type"] })
    & ([_Headers["Type"]] extends [never] ? {} : { readonly headers: _Headers["Type"] })
    & {
      readonly request: HttpServerRequest
      readonly endpoint: Endpoint
      readonly group: HttpApiGroup.AnyWithProps
    }
  : {}

/**
 * Builds the request object accepted by a generated client method, including only
 * the params, query, headers, payload, and response mode fields required by the
 * endpoint. Multipart payloads are supplied as `FormData`.
 *
 * @category models
 * @since 4.0.0
 */
export type ClientRequest<
  Params extends Schema.Constraint,
  Query extends Schema.Constraint,
  Payload extends Schema.Constraint,
  Headers extends Schema.Constraint,
  ResponseMode extends ClientResponseMode
> = (
  & ([Params["Type"]] extends [never] ? {} : { readonly params: Params["Type"] })
  & ([Query["Type"]] extends [never] ? {} : { readonly query: Query["Type"] })
  & ([Headers["Type"]] extends [never] ? {} : { readonly headers: Headers["Type"] })
  & ([Payload["Type"]] extends [never] ? {}
    : Payload["Type"] extends infer P ?
      P extends Brand<HttpApiSchema.MultipartTypeId> | Brand<HttpApiSchema.MultipartStreamTypeId>
        ? { readonly payload: FormData }
      : { readonly payload: Payload["Type"] }
    : { readonly payload: Payload["Type"] })
) extends infer Req ? keyof Req extends never ? (void | { readonly responseMode?: ResponseMode }) :
  Req & { readonly responseMode?: ResponseMode } :
  void

/**
 * Controls what a generated client method returns: the decoded success value,
 * the decoded value paired with the raw response, or only the raw response.
 *
 * @category models
 * @since 4.0.0
 */
export type ClientResponseMode = "decoded-only" | "decoded-and-response" | "response-only"

/**
 * Computes the services required on the server to decode endpoint inputs and
 * encode endpoint success, error, and middleware error responses.
 *
 * @category models
 * @since 4.0.0
 */
export type ServerServices<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ?
    | _Params["DecodingServices"]
    | _Query["DecodingServices"]
    | _Payload["DecodingServices"]
    | _Headers["DecodingServices"]
    | SuccessEncodingServices<_Success>
    | _Error["EncodingServices"]
    | HttpApiMiddleware.ErrorServicesEncode<_M>
  : never

/**
 * Computes the services required on the client to encode endpoint requests and
 * decode endpoint success or error responses.
 *
 * @category models
 * @since 4.0.0
 */
export type ClientServices<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ?
    | _Params["EncodingServices"]
    | _Query["EncodingServices"]
    | _Payload["EncodingServices"]
    | _Headers["EncodingServices"]
    | SuccessDecodingServices<_Success>
    | _Error["DecodingServices"]
  : never

/**
 * Extracts the additional services required by middleware applied to an endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareServices<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _MR
  : never

/**
 * Computes the services required to decode an endpoint's error responses,
 * including services required by middleware error decoders.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesDecode<Endpoint> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? _Error["DecodingServices"] | HttpApiMiddleware.ErrorServicesDecode<Middleware<Endpoint>>
  : never

/**
 * The normal server handler for an endpoint, accepting the decoded request shape
 * and returning either the endpoint success value or a custom `HttpServerResponse`.
 *
 * @category models
 * @since 4.0.0
 */
export type Handler<Endpoint extends Any, E, R> = (
  request: Types.Simplify<Request<Endpoint>>
) => Effect<SuccessType<Endpoint["~Success"]> | HttpServerResponse, Endpoint["~Error"]["Type"] | E, R>

/**
 * The raw server handler for an endpoint, receiving a request shape without a
 * decoded payload so the handler can read the raw `HttpServerRequest` directly.
 *
 * @category models
 * @since 4.0.0
 */
export type HandlerRaw<Endpoint extends Any, E, R> = (
  request: Types.Simplify<RequestRaw<Endpoint>>
) => Effect<SuccessType<Endpoint["~Success"]> | HttpServerResponse, Endpoint["~Error"]["Type"] | E, R>

/**
 * Selects the endpoint with the specified name from a union of endpoints.
 *
 * @category models
 * @since 4.0.0
 */
export type WithName<Endpoints extends Any, Name extends string> = Extract<Endpoints, { readonly name: Name }>

/**
 * Removes endpoints with the specified name from a union of endpoints.
 *
 * @category models
 * @since 4.0.0
 */
export type ExcludeName<Endpoints extends Any, Name extends string> = Exclude<Endpoints, { readonly name: Name }>

/**
 * Derives the normal handler type for the endpoint with the specified name in an
 * endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type HandlerWithName<Endpoints extends Any, Name extends string, E, R> = Handler<
  WithName<Endpoints, Name>,
  E,
  R
>

/**
 * Derives the raw handler type for the endpoint with the specified name in an
 * endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type HandlerRawWithName<Endpoints extends Any, Name extends string, E, R> = HandlerRaw<
  WithName<Endpoints, Name>,
  E,
  R
>

/**
 * Extracts the decoded success value type for the endpoint with the specified name
 * in an endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type SuccessWithName<Endpoints extends Any, Name extends string> = Success<
  WithName<Endpoints, Name>
> extends infer S ? SuccessType<S> : never

/**
 * Computes the full error value union for the endpoint with the specified name in
 * an endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorsWithName<Endpoints extends Any, Name extends string> = Errors<WithName<Endpoints, Name>>

/**
 * Computes the server-side service requirements for the endpoint with the
 * specified name in an endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type ServerServicesWithName<Endpoints extends Any, Name extends string> = ServerServices<
  WithName<Endpoints, Name>
>

/**
 * Extracts the middleware identifiers for the endpoint with the specified name in
 * an endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareWithName<Endpoints extends Any, Name extends string> = Middleware<WithName<Endpoints, Name>>

/**
 * Extracts the middleware service requirements for the endpoint with the specified
 * name in an endpoint union.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareServicesWithName<Endpoints extends Any, Name extends string> = MiddlewareServices<
  WithName<Endpoints, Name>
>

/**
 * Removes services provided by the HTTP router and the named endpoint's middleware
 * from a service requirement union.
 *
 * @category models
 * @since 4.0.0
 */
export type ExcludeProvidedWithName<Endpoints extends Any, Name extends string, R> = ExcludeProvided<
  WithName<Endpoints, Name>,
  R
>

/**
 * Removes services provided by the HTTP router and endpoint middleware from a
 * service requirement union.
 *
 * @category models
 * @since 4.0.0
 */
export type ExcludeProvided<Endpoint extends Any, R> = Exclude<
  R,
  | HttpRouter.Provided
  | HttpApiMiddleware.Provides<Middleware<Endpoint>>
>

/**
 * Returns an endpoint type with the supplied path prefix prepended while
 * preserving the endpoint's schemas, method, errors, and middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type AddPrefix<Endpoint extends Any, Prefix extends HttpRouter.PathInput> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? HttpApiEndpoint<
    _Name,
    _Method,
    `${Prefix}${_Path}`,
    _Params,
    _Query,
    _Payload,
    _Headers,
    _Success,
    _Error,
    _M,
    _MR
  > :
  never

/**
 * Returns an endpoint type with an additional error schema added to the endpoint's
 * existing error schema union.
 *
 * @category models
 * @since 4.0.0
 */
export type AddError<Endpoint extends Any, E extends Schema.Top> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? HttpApiEndpoint<
    _Name,
    _Method,
    _Path,
    _Params,
    _Query,
    _Payload,
    _Headers,
    _Success,
    _Error | E,
    _M,
    _MR
  > :
  never

/**
 * Returns an endpoint type with additional middleware applied and the endpoint's
 * middleware service requirements updated accordingly.
 *
 * @category models
 * @since 4.0.0
 */
export type AddMiddleware<Endpoint extends Any, M extends HttpApiMiddleware.AnyId> = Endpoint extends HttpApiEndpoint<
  infer _Name,
  infer _Method,
  infer _Path,
  infer _Params,
  infer _Query,
  infer _Payload,
  infer _Headers,
  infer _Success,
  infer _Error,
  infer _M,
  infer _MR
> ? HttpApiEndpoint<
    _Name,
    _Method,
    _Path,
    _Params,
    _Query,
    _Payload,
    _Headers,
    _Success,
    _Error,
    _M | M,
    HttpApiMiddleware.ApplyServices<M, _MR>
  > :
  never

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  prefix(this: AnyWithProps, prefix: HttpRouter.PathInput) {
    return makeProto({
      ...this,
      path: HttpRouter.prefixPath(this.path, prefix)
    })
  },
  middleware(this: AnyWithProps, middleware: HttpApiMiddleware.AnyService) {
    return makeProto({
      ...this,
      middlewares: new Set([...this.middlewares, middleware as any])
    })
  },
  annotate(this: AnyWithProps, key: Context.Key<any, any>, value: any) {
    return makeProto({
      ...this,
      annotations: Context.add(this.annotations, key, value)
    })
  },
  annotateMerge(this: AnyWithProps, annotations: Context.Context<any>) {
    return makeProto({
      ...this,
      annotations: Context.merge(this.annotations, annotations)
    })
  }
}

function makeProto<
  Name extends string,
  Method extends HttpMethod,
  const Path extends string,
  Params extends Schema.Top,
  Query extends Schema.Top,
  Payload extends Schema.Top,
  Headers extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware,
  MiddlewareR
>(options: {
  readonly name: Name
  readonly path: Path
  readonly method: Method
  readonly params: Schema.Top | undefined
  readonly query: Schema.Top | undefined
  readonly headers: Schema.Top | undefined
  readonly payload: PayloadMap
  readonly success: ReadonlySet<Schema.Top>
  readonly error: ReadonlySet<Schema.Top>
  readonly annotations: Context.Context<never>
  readonly middlewares: ReadonlySet<Context.Key<Middleware, any>>
}): HttpApiEndpoint<
  Name,
  Method,
  Path,
  Params,
  Query,
  Payload,
  Headers,
  Success,
  Error,
  Middleware,
  MiddlewareR
> {
  return Object.assign(Object.create(Proto), options)
}

/**
 * Constraint for path parameter schemas: each parameter must encode to
 * `string | undefined`, or the schema must encode to a record of those values.
 *
 * @category constraints
 * @since 4.0.0
 */
export type ParamsConstraint =
  | Record<string, Schema.Codec<unknown, string | undefined, unknown, unknown>>
  | Schema.Codec<unknown, Record<string, string | undefined>, unknown, unknown>

/**
 * Constraint for header schemas: each header must encode to `string | undefined`,
 * or the schema must encode to a record of those values.
 *
 * @category constraints
 * @since 4.0.0
 */
export type HeadersConstraint =
  | Record<string, Schema.Codec<unknown, string | undefined, unknown, unknown>>
  | Schema.Codec<unknown, Record<string, string | undefined>, unknown, unknown>

/**
 * Constraint for query schemas: each field must encode to `string`, an array of
 * strings, or `undefined`, or the schema must encode to a record of those values.
 *
 * @category constraints
 * @since 4.0.0
 */
export type QueryConstraint =
  | Record<string, Schema.Codec<unknown, string | ReadonlyArray<string> | undefined, unknown, unknown>>
  | Schema.Codec<unknown, string | ReadonlyArray<string> | undefined, unknown, unknown>

/**
 * Payload schema depends on the HTTP method:
 * - for no-body methods, payload is modeled as query params, so each field must
 *   encode to `string | ReadonlyArray<string> | undefined` and OpenAPI can expand
 *   it into `in: query` parameters
 * - for body methods, payload may be any `Schema.Top` (or content-type keyed
 *   schemas) and OpenAPI uses `requestBody` instead of `parameters`
 *
 * @category constraints
 * @since 4.0.0
 */
export type PayloadConstraint<Method extends HttpMethod> = Method extends HttpMethod.NoBody ? Record<
    string,
    Schema.Codec<unknown, string | ReadonlyArray<string> | undefined, unknown, unknown>
  > :
  Schema.Top | ReadonlyArray<Schema.Top>

/**
 * Payload constraint used when automatic codecs are enabled: no-body methods
 * accept field records for query-style encoding, while body methods accept one or
 * more schemas.
 *
 * @category constraints
 * @since 4.0.0
 */
export type PayloadConstraintCodecs<Method extends HttpMethod> = Method extends HttpMethod.NoBody ?
  Record<string, Schema.Top> :
  Schema.Top | ReadonlyArray<Schema.Top>

/**
 * Constraint for success response schemas, allowing either a single schema or a
 * readonly array of schemas.
 *
 * @category constraints
 * @since 4.0.0
 */
export type SuccessConstraint = Schema.Top | ReadonlyArray<Schema.Top>

/**
 * Constraint for error response schemas, allowing either a single schema or a
 * readonly array of schemas.
 *
 * @category constraints
 * @since 4.0.0
 */
export type ErrorConstraint = Schema.Top | ReadonlyArray<Schema.Top>

type ErrorNoStream<S extends ErrorConstraint> = [
  Extract<
    S extends ReadonlyArray<Schema.Constraint> ? S[number] : S,
    HttpApiSchema.StreamSchema
  >
] extends [never] ? S : never

/**
 * Creates endpoint constructors for a specific HTTP method. The resulting
 * constructor builds an `HttpApiEndpoint` from a name, path, and optional request
 * and response schemas, applying automatic JSON or string-tree codecs unless
 * `disableCodecs` is enabled.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <Method extends HttpMethod>(method: Method): {
  <
    const Name extends string,
    const Path extends HttpRouter.PathInput,
    Params extends Schema.Top | Schema.Struct.Fields = never,
    Query extends Schema.Top | Schema.Struct.Fields = never,
    Payload extends PayloadConstraintCodecs<Method> = never,
    Headers extends Schema.Top | Schema.Struct.Fields = never,
    const Success extends SuccessConstraint = HttpApiSchema.NoContent,
    const Error extends Schema.Top | ReadonlyArray<Schema.Top> = never
  >(
    name: Name,
    path: Path,
    options?: {
      readonly disableCodecs?: false | undefined
      readonly params?: Params | undefined
      readonly query?: Query | undefined
      readonly headers?: Headers | undefined
      readonly payload?: Payload | undefined
      readonly success?: Success | undefined
      readonly error?: (Error & ErrorNoStream<Types.NoInfer<Error>>) | undefined
    }
  ): HttpApiEndpoint<
    Name,
    Method,
    Path,
    StringTree<Params extends Schema.Struct.Fields ? Schema.Struct<Params> : Params>,
    StringTree<Query extends Schema.Struct.Fields ? Schema.Struct<Query> : Query>,
    Method extends HttpMethod.WithBody ? Json<ExtractSchemaOrArray<Payload>>
      : StringTree<ExtractSchemaOrArray<Payload>>,
    StringTree<Headers extends Schema.Struct.Fields ? Schema.Struct<Headers> : Headers>,
    JsonSuccessOrArray<Success>,
    Json<Error extends ReadonlyArray<Schema.Constraint> ? Error[number] : Error>
  >
  <
    const Name extends string,
    const Path extends HttpRouter.PathInput,
    Params extends ParamsConstraint = never,
    Query extends QueryConstraint = never,
    Payload extends PayloadConstraint<Method> = never,
    Headers extends HeadersConstraint = never,
    const Success extends SuccessConstraint = HttpApiSchema.NoContent,
    const Error extends ErrorConstraint = never
  >(
    name: Name,
    path: Path,
    options?: {
      readonly disableCodecs: true
      readonly params?: Params | undefined
      readonly query?: Query | undefined
      readonly headers?: Headers | undefined
      readonly payload?: Payload | undefined
      readonly success?: Success | undefined
      readonly error?: (Error & ErrorNoStream<Types.NoInfer<Error>>) | undefined
    }
  ): HttpApiEndpoint<
    Name,
    Method,
    Path,
    Params extends Schema.Struct.Fields ? Schema.Struct<Params> : Params,
    Query extends Schema.Struct.Fields ? Schema.Struct<Query> : Query,
    ExtractSchemaOrArray<Payload>,
    ExtractSchemaOrArray<Headers>,
    ExtractSuccessOrArray<Success>,
    Error extends ReadonlyArray<Schema.Constraint> ? Error[number] : Error
  >
} =>
<
  const Name extends string,
  const Path extends HttpRouter.PathInput,
  Params extends ParamsConstraint = never,
  Query extends QueryConstraint = never,
  Payload extends PayloadConstraint<Method> = never,
  Headers extends HeadersConstraint = never,
  const Success extends SuccessConstraint = HttpApiSchema.NoContent,
  const Error extends ErrorConstraint = never
>(
  name: Name,
  path: Path,
  options?: {
    readonly disableCodecs?: boolean | undefined
    readonly params?: Params | undefined
    readonly query?: Query | undefined
    readonly headers?: Headers | undefined
    readonly payload?: Payload | undefined
    readonly success?: Success | undefined
    readonly error?: (Error & ErrorNoStream<Types.NoInfer<Error>>) | undefined
  }
): HttpApiEndpoint<
  Name,
  Method,
  Path,
  Params extends Schema.Struct.Fields ? Schema.Struct<Params> : Params,
  Query extends Schema.Struct.Fields ? Schema.Struct<Query> : Query,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload>
    : Payload extends ReadonlyArray<Schema.Constraint> ? Payload[number]
    : Payload,
  Headers extends Schema.Struct.Fields ? Schema.Struct<Headers> : Headers,
  ExtractSuccessOrArray<Success>,
  Error extends ReadonlyArray<Schema.Constraint> ? Error[number] : Error
> => {
  const disableCodecs = options?.disableCodecs ?? false
  const transformStringTree = disableCodecs ? identity : Schema.toCodecStringTree
  return makeProto({
    name,
    path,
    method,
    params: ensureStruct(options?.params, transformStringTree),
    query: ensureStruct(options?.query, transformStringTree),
    headers: ensureStruct(options?.headers, transformStringTree),
    payload: getPayload(options?.payload, method, disableCodecs),
    success: getSuccessResponse(options?.success, method, disableCodecs),
    error: getErrorResponse(options?.error, disableCodecs),
    annotations: Context.empty(),
    middlewares: new Set()
  })
}

type ExtractSchemaOrArray<S extends Schema.Struct.Fields | Schema.Constraint | ReadonlyArray<Schema.Constraint>> =
  S extends Schema.Struct.Fields ? Schema.Struct<S>
    : S extends ReadonlyArray<Schema.Constraint> ? S[number]
    : S

/**
 * A schema codec that decodes and encodes the schema's value type through JSON
 * transport values.
 *
 * @category Codecs
 * @since 4.0.0
 */
export interface Json<S extends Schema.Constraint>
  extends Schema.Codec<S["Type"], Schema.Json, S["DecodingServices"], S["EncodingServices"]>
{}

/**
 * A schema codec that decodes and encodes the schema's value type through
 * `Schema.StringTree` transport values.
 *
 * @category Codecs
 * @since 4.0.0
 */
export interface StringTree<S extends Schema.Constraint> extends
  Schema.Codec<
    S["Type"],
    Schema.StringTree,
    S["DecodingServices"],
    S["EncodingServices"]
  >
{}

function ensureStruct(
  params: Schema.Struct.Fields | Schema.Top | undefined,
  transform: (schema: Schema.Top) => Schema.Top
): Schema.Top | undefined {
  if (params === undefined) return undefined
  if (Schema.isSchema(params)) return transform(params)
  return transform(Schema.Struct(params))
}

function getPayload(
  payload: Schema.Constraint | ReadonlyArray<Schema.Constraint> | Schema.Struct.Fields | undefined,
  method: HttpMethod,
  disableCodecs: boolean
): PayloadMap {
  const result: Map<
    string,
    { encoding: HttpApiSchema.PayloadEncoding; schemas: [Schema.Top, ...Array<Schema.Top>] }
  > = new Map()
  if (payload === undefined) return result
  const schemas: Array<Schema.Top> = Array.isArray(payload)
    ? payload
    : Schema.isSchema(payload)
    ? [payload]
    : [(Schema.Struct(payload as any)).pipe(HttpApiSchema.asFormUrlEncoded())]
  const transform = disableCodecs ? identity : transformPayload

  for (const schema of schemas) {
    const encoding = HttpApiSchema.getPayloadEncoding(schema.ast, method)
    const existing = result.get(encoding.contentType)
    if (existing) {
      if (existing.encoding._tag !== encoding._tag) {
        throw new Error(`Multiple payload encodings for content-type: ${encoding.contentType}`)
      }
      if (existing.encoding._tag === "Multipart") {
        throw new Error(`Multiple multipart payloads for content-type: ${encoding.contentType}`)
      }
      existing.schemas.push(transform(schema, method))
    } else {
      result.set(encoding.contentType, { encoding, schemas: [transform(schema, method)] })
    }
  }
  return result
}

const reservedStreamFailureEvent = "effect/httpapi/stream/failure"

function getSuccessResponse(
  success: Schema.Top | ReadonlyArray<Schema.Top> | undefined,
  method: HttpMethod,
  disableCodecs: boolean
): Set<Schema.Top> {
  if (success === undefined) return new Set()
  const schemas = Arr.ensure(success)
  validateSuccessResponse(schemas, method)
  return new Set(
    disableCodecs ?
      schemas :
      schemas.map((schema) => HttpApiSchema.isStreamSchema(schema) ? schema : transformResponse(schema))
  )
}

function getErrorResponse(
  error: Schema.Top | ReadonlyArray<Schema.Top> | undefined,
  disableCodecs: boolean
): Set<Schema.Top> {
  if (error === undefined) return new Set()
  const schemas = Arr.ensure(error)
  for (const schema of schemas) {
    if (HttpApiSchema.isStreamSchema(schema)) {
      throw new Error("Streaming schemas are not supported in error responses")
    }
  }
  return new Set(disableCodecs ? schemas : schemas.map(transformResponse))
}

function validateSuccessResponse(schemas: ReadonlyArray<Schema.Constraint>, method: HttpMethod) {
  const statuses = new Map<number, {
    readonly stream?: HttpApiSchema.StreamSchema | undefined
    bufferedContentTypes: Set<string>
    noContent: boolean
  }>()

  for (const schema of schemas) {
    if (HttpApiSchema.isStreamSchema(schema)) {
      validateStreamSuccess(schema, method)
      const status = HttpApiSchema.getStatusStream(schema)
      const entry = getStatusEntry(statuses, status)
      if (entry.stream !== undefined) {
        throw new Error(`Multiple streaming success responses for status: ${status}`)
      }
      if (entry.noContent) {
        throw new Error(`Cannot combine no-content and streaming success responses for status: ${status}`)
      }
      if (entry.bufferedContentTypes.has(normalizeResponseContentType(schema.contentType))) {
        throw new Error(
          `Cannot combine buffered and streaming success responses for status ${status} and content-type: ${schema.contentType}`
        )
      }
      statuses.set(status, { ...entry, stream: schema })
    } else {
      const status = HttpApiSchema.getStatusSuccess(schema.ast)
      const entry = getStatusEntry(statuses, status)
      const noContent = HttpApiSchema.isNoContent(schema.ast)
      if (entry.stream !== undefined) {
        if (noContent) {
          throw new Error(`Cannot combine no-content and streaming success responses for status: ${status}`)
        }
        const encoding = HttpApiSchema.getResponseEncoding(schema.ast)
        if (
          normalizeResponseContentType(encoding.contentType) === normalizeResponseContentType(entry.stream.contentType)
        ) {
          throw new Error(
            `Cannot combine buffered and streaming success responses for status ${status} and content-type: ${encoding.contentType}`
          )
        }
      }
      if (!noContent) {
        entry.bufferedContentTypes.add(
          normalizeResponseContentType(HttpApiSchema.getResponseEncoding(schema.ast).contentType)
        )
      }
      entry.noContent = entry.noContent || noContent
    }
  }
}

function normalizeResponseContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().trim()
  const index = normalized.indexOf(";")
  return index === -1 ? normalized : normalized.slice(0, index).trim()
}

function getStatusEntry(
  statuses: Map<number, {
    readonly stream?: HttpApiSchema.StreamSchema | undefined
    bufferedContentTypes: Set<string>
    noContent: boolean
  }>,
  status: number
) {
  let entry = statuses.get(status)
  if (entry === undefined) {
    entry = { bufferedContentTypes: new Set(), noContent: false }
    statuses.set(status, entry)
  }
  return entry
}

function validateStreamSuccess(schema: HttpApiSchema.StreamSchema, method: HttpMethod) {
  if (method === "HEAD") {
    throw new Error("HEAD endpoints cannot declare streaming success responses")
  }
  if (HttpApiSchema.isStreamSse(schema) && hasReservedSseEventName(schema.events.ast)) {
    throw new Error(`SSE event name is reserved: ${reservedStreamFailureEvent}`)
  }
}

function hasReservedSseEventName(ast: AST.AST): boolean {
  return hasReservedEventName(AST.toEncoded(ast), new Set())
}

function hasReservedEventName(ast: AST.AST, seen: Set<AST.AST>): boolean {
  if (seen.has(ast)) return false
  seen.add(ast)
  if (AST.isUnion(ast)) {
    return ast.types.some((type) => hasReservedEventName(type, seen))
  }
  if (AST.isSuspend(ast)) {
    return hasReservedEventName(ast.thunk(), seen)
  }
  if (!AST.isObjects(ast)) return false
  const event = ast.propertySignatures.find((ps) => ps.name === "event")
  return event !== undefined && hasReservedEventLiteral(event.type, seen)
}

function hasReservedEventLiteral(ast: AST.AST, seen: Set<AST.AST>): boolean {
  if (seen.has(ast)) return false
  seen.add(ast)
  const encoded = AST.toEncoded(ast)
  if (encoded !== ast) {
    return hasReservedEventLiteral(encoded, seen)
  }
  if (AST.isLiteral(ast)) {
    return ast.literal === reservedStreamFailureEvent
  }
  if (AST.isUnion(ast)) {
    return ast.types.some((type) => hasReservedEventLiteral(type, seen))
  }
  if (AST.isSuspend(ast)) {
    return hasReservedEventLiteral(ast.thunk(), seen)
  }
  return false
}

function transformResponse(schema: Schema.Top): Schema.Top {
  const encoding = HttpApiSchema.getResponseEncoding(schema.ast)
  switch (encoding._tag) {
    case "Json":
      return Schema.toCodecJson(schema)
    case "FormUrlEncoded":
      return Schema.toCodecStringTree(schema)
    case "Text":
    case "Uint8Array":
      return schema
  }
}

function transformPayload(schema: Schema.Top, method: HttpMethod): Schema.Top {
  const encoding = HttpApiSchema.getPayloadEncoding(schema.ast, method)
  switch (encoding._tag) {
    case "Json":
      return Schema.toCodecJson(schema)
    case "FormUrlEncoded":
      return Schema.toCodecStringTree(schema)
    case "Text":
    case "Uint8Array":
    case "Multipart":
      return schema
  }
}

/**
 * Creates a `GET` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const get = make("GET")

/**
 * Creates a `POST` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const post = make("POST")

/**
 * Creates a `PUT` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const put = make("PUT")

/**
 * Creates a `PATCH` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const patch = make("PATCH")

const del = make("DELETE")

export {
  /**
   * Creates a `DELETE` endpoint declaration.
   *
   * @category constructors
   * @since 4.0.0
   */
  del as delete
}

/**
 * Creates a `HEAD` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const head = make("HEAD")

/**
 * Creates an `OPTIONS` endpoint declaration.
 *
 * @category constructors
 * @since 4.0.0
 */
export const options = make("OPTIONS")
