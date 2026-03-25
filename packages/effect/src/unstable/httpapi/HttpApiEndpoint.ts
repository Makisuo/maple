/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type { Brand } from "../../Brand.ts"
import type { Effect } from "../../Effect.ts"
import { identity } from "../../Function.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Stream from "../../Stream.ts"
import type * as Types from "../../Types.ts"
import type { HttpMethod } from "../http/HttpMethod.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import type { HttpServerRequest } from "../http/HttpServerRequest.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import type * as Multipart from "../http/Multipart.ts"
import { BadRequestFromSchemaError, type BadRequestNoContent } from "./HttpApiError.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

const TypeId = "~effect/httpapi/HttpApiEndpoint"

/**
 * @since 4.0.0
 * @category guards
 */
export const isHttpApiEndpoint = (u: unknown): u is HttpApiEndpoint<any, any, any> => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export type PayloadMap = ReadonlyMap<string, {
  readonly encoding: HttpApiSchema.PayloadEncoding
  readonly schemas: [Schema.Top, ...Array<Schema.Top>]
}>

/**
 * Represents an API endpoint. An API endpoint is mapped to a single route on
 * the underlying `HttpRouter`.
 *
 * @since 4.0.0
 * @category models
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
  out Error extends Schema.Top = typeof BadRequestNoContent,
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
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly middlewares: ReadonlySet<ServiceMap.Key<Middleware, any>>

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
  middleware<I extends HttpApiMiddleware.AnyId, S>(middleware: ServiceMap.Key<I, S>): HttpApiEndpoint<
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
    key: ServiceMap.Key<I, S>,
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
   * Merge the annotations of the endpoint with the provided service map.
   */
  annotateMerge<I>(
    annotations: ServiceMap.ServiceMap<I>
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
export function getErrorSchemas(endpoint: AnyWithProps): [Schema.Top, ...Array<Schema.Top>] {
  const schemas = new Set<Schema.Top>(endpoint.error)
  for (const middleware of endpoint.middlewares) {
    const key = middleware as any as HttpApiMiddleware.AnyService
    for (const schema of key.error) {
      schemas.add(schema)
    }
  }
  return Arr.append(Array.from(schemas), BadRequestFromSchemaError)
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any extends Pipeable {
  readonly [TypeId]: any
  readonly name: string
  readonly ["~Success"]: Schema.Top
  readonly ["~Error"]: Schema.Top
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyWithProps
  extends HttpApiEndpoint<string, HttpMethod, string, Schema.Top, Schema.Top, Schema.Top, Schema.Top, any, any>
{}

/**
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
 */
export type MiddlewareProvides<Endpoint extends Any> = HttpApiMiddleware.Provides<Middleware<Endpoint>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareClient<Endpoint extends Any> = HttpApiMiddleware.MiddlewareClient<Middleware<Endpoint>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareError<Endpoint extends Any> = HttpApiMiddleware.Error<Middleware<Endpoint>>

/**
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
 */
export type ClientRequest<
  Params extends Schema.Top,
  Query extends Schema.Top,
  Payload extends Schema.Top,
  Headers extends Schema.Top,
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
 * @since 4.0.0
 * @category models
 */
export type ClientResponseMode = "decoded-only" | "decoded-and-response" | "response-only"

/**
 * @since 4.0.0
 * @category models
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
    | _Success["EncodingServices"]
    | _Error["EncodingServices"]
    | HttpApiMiddleware.ErrorServicesEncode<_M>
  : never

/**
 * @since 4.0.0
 * @category models
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
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
 */
export type Handler<Endpoint extends Any, E, R> = (
  request: Types.Simplify<Request<Endpoint>>
) => Effect<Endpoint["~Success"]["Type"] | HttpServerResponse, Endpoint["~Error"]["Type"] | E, R>

/**
 * @since 4.0.0
 * @category models
 */
export type HandlerRaw<Endpoint extends Any, E, R> = (
  request: Types.Simplify<RequestRaw<Endpoint>>
) => Effect<Endpoint["~Success"]["Type"] | HttpServerResponse, Endpoint["~Error"]["Type"] | E, R>

/**
 * @since 4.0.0
 * @category models
 */
export type WithName<Endpoints extends Any, Name extends string> = Extract<Endpoints, { readonly name: Name }>

/**
 * @since 4.0.0
 * @category models
 */
export type ExcludeName<Endpoints extends Any, Name extends string> = Exclude<Endpoints, { readonly name: Name }>

/**
 * @since 4.0.0
 * @category models
 */
export type HandlerWithName<Endpoints extends Any, Name extends string, E, R> = Handler<
  WithName<Endpoints, Name>,
  E,
  R
>

/**
 * @since 4.0.0
 * @category models
 */
export type HandlerRawWithName<Endpoints extends Any, Name extends string, E, R> = HandlerRaw<
  WithName<Endpoints, Name>,
  E,
  R
>

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessWithName<Endpoints extends Any, Name extends string> = Success<
  WithName<Endpoints, Name>
>["Type"]

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorsWithName<Endpoints extends Any, Name extends string> = Errors<WithName<Endpoints, Name>>

/**
 * @since 4.0.0
 * @category models
 */
export type ServerServicesWithName<Endpoints extends Any, Name extends string> = ServerServices<
  WithName<Endpoints, Name>
>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareWithName<Endpoints extends Any, Name extends string> = Middleware<WithName<Endpoints, Name>>

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareServicesWithName<Endpoints extends Any, Name extends string> = MiddlewareServices<
  WithName<Endpoints, Name>
>

/**
 * @since 4.0.0
 * @category models
 */
export type ExcludeProvidedWithName<Endpoints extends Any, Name extends string, R> = ExcludeProvided<
  WithName<Endpoints, Name>,
  R
>

/**
 * @since 4.0.0
 * @category models
 */
export type ExcludeProvided<Endpoint extends Any, R> = Exclude<
  R,
  | HttpRouter.Provided
  | HttpApiMiddleware.Provides<Middleware<Endpoint>>
>

/**
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
 * @since 4.0.0
 * @category models
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
  annotate(this: AnyWithProps, key: ServiceMap.Key<any, any>, value: any) {
    return makeProto({
      ...this,
      annotations: ServiceMap.add(this.annotations, key, value)
    })
  },
  annotateMerge(this: AnyWithProps, annotations: ServiceMap.ServiceMap<any>) {
    return makeProto({
      ...this,
      annotations: ServiceMap.merge(this.annotations, annotations)
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
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly middlewares: ReadonlySet<ServiceMap.Key<Middleware, any>>
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
 * @since 4.0.0
 * @category constraints
 */
export type ParamsConstraint =
  | Record<string, Schema.Encoder<string | undefined, unknown>>
  | Schema.Encoder<Record<string, string | undefined>, unknown>

/**
 * @since 4.0.0
 * @category constraints
 */
export type HeadersConstraint =
  | Record<string, Schema.Encoder<string | undefined, unknown>>
  | Schema.Encoder<Record<string, string | undefined>, unknown>

/**
 * @since 4.0.0
 * @category constraints
 */
export type QueryConstraint =
  | Record<string, Schema.Encoder<string | ReadonlyArray<string> | undefined, unknown>>
  | Schema.Encoder<Record<string, string | ReadonlyArray<string> | undefined>, unknown>

/**
 * Payload schema depends on the HTTP method:
 * - for no-body methods, payload is modeled as query params, so each field must
 *   encode to `string | ReadonlyArray<string> | undefined` and OpenAPI can expand
 *   it into `in: query` parameters
 * - for body methods, payload may be any `Schema.Top` (or content-type keyed
 *   schemas) and OpenAPI uses `requestBody` instead of `parameters`
 *
 * @since 4.0.0
 * @category constraints
 */
export type PayloadConstraint<Method extends HttpMethod> = Method extends HttpMethod.NoBody ? Record<
    string,
    Schema.Encoder<string | ReadonlyArray<string> | undefined, unknown>
  > :
  SuccessConstraint

/**
 * @since 4.0.0
 * @category constraints
 */
export type PayloadConstraintCodecs<Method extends HttpMethod> = Method extends HttpMethod.NoBody ?
  Record<string, Schema.Top> :
  Schema.Top | ReadonlyArray<Schema.Top>

/**
 * @since 4.0.0
 * @category constraints
 */
export type SuccessConstraint = Schema.Top | ReadonlyArray<Schema.Top>

/**
 * @since 4.0.0
 * @category constraints
 */
export type ErrorConstraint = Schema.Top | ReadonlyArray<Schema.Top>

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <Method extends HttpMethod>(method: Method): {
  <
    const Name extends string,
    const Path extends HttpRouter.PathInput,
    Params extends Schema.Top | Schema.Struct.Fields = never,
    Query extends Schema.Top | Schema.Struct.Fields = never,
    Payload extends PayloadConstraintCodecs<Method> = never,
    Headers extends Schema.Top | Schema.Struct.Fields = never,
    const Success extends Schema.Top | ReadonlyArray<Schema.Top> = HttpApiSchema.NoContent,
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
      readonly error?: Error | undefined
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
    Json<Success extends ReadonlyArray<Schema.Top> ? Success[number] : Success>,
    Json<(Error extends ReadonlyArray<Schema.Top> ? Error[number] : Error) | typeof BadRequestNoContent>
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
      readonly error?: Error | undefined
    }
  ): HttpApiEndpoint<
    Name,
    Method,
    Path,
    Params extends Schema.Struct.Fields ? Schema.Struct<Params> : Params,
    Query extends Schema.Struct.Fields ? Schema.Struct<Query> : Query,
    ExtractSchemaOrArray<Payload>,
    ExtractSchemaOrArray<Headers>,
    Success extends ReadonlyArray<Schema.Top> ? Success[number] : Success,
    (Error extends ReadonlyArray<Schema.Top> ? Error[number] : Error) | typeof BadRequestNoContent
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
    readonly error?: Error | undefined
  }
): HttpApiEndpoint<
  Name,
  Method,
  Path,
  Params extends Schema.Struct.Fields ? Schema.Struct<Params> : Params,
  Query extends Schema.Struct.Fields ? Schema.Struct<Query> : Query,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload>
    : Payload extends ReadonlyArray<Schema.Top> ? Payload[number]
    : Payload,
  Headers extends Schema.Struct.Fields ? Schema.Struct<Headers> : Headers,
  Success extends ReadonlyArray<Schema.Top> ? Success[number] : Success,
  (Error extends ReadonlyArray<Schema.Top> ? Error[number] : Error) | typeof BadRequestNoContent
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
    success: getResponse(options?.success, disableCodecs),
    error: getResponse(options?.error, disableCodecs),
    annotations: ServiceMap.empty(),
    middlewares: new Set()
  })
}

type ExtractSchemaOrArray<S extends Schema.Struct.Fields | Schema.Top | ReadonlyArray<Schema.Top>> = S extends
  Schema.Struct.Fields ? Schema.Struct<S>
  : S extends ReadonlyArray<Schema.Top> ? S[number]
  : S

/**
 * @since 4.0.0
 * @category Codecs
 */
export interface Json<S extends Schema.Top>
  extends Schema.Codec<S["Type"], Schema.Json, S["DecodingServices"], S["EncodingServices"]>
{}

/**
 * @since 4.0.0
 * @category Codecs
 */
export interface StringTree<S extends Schema.Top> extends
  Schema.Codec<
    S["Type"],
    Schema.StringTree,
    S["DecodingServices"],
    S["EncodingServices"]
  >
{}

function ensureStruct(
  params: Schema.Struct.Fields | Schema.Top | undefined,
  transform: typeof Schema.toCodecJson | typeof Schema.toCodecStringTree
): Schema.Top | undefined {
  if (params === undefined) return undefined
  if (Schema.isSchema(params)) return transform(params)
  return transform(Schema.Struct(params))
}

function getPayload(
  payload: Schema.Top | ReadonlyArray<Schema.Top> | Schema.Struct.Fields | undefined,
  method: HttpMethod,
  disableCodecs: boolean
): PayloadMap {
  const result: Map<string, { encoding: HttpApiSchema.PayloadEncoding; schemas: [Schema.Top, ...Array<Schema.Top>] }> =
    new Map()
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

function getResponse(
  success: Schema.Top | ReadonlyArray<Schema.Top> | undefined,
  disableCodecs: boolean
): Set<Schema.Top> {
  if (success === undefined) return new Set()
  const arr = Arr.ensure(success)
  return new Set(disableCodecs ? arr : arr.map(transformResponse))
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
 * @since 4.0.0
 * @category constructors
 */
export const get = make("GET")

/**
 * @since 4.0.0
 * @category constructors
 */
export const post = make("POST")

/**
 * @since 4.0.0
 * @category constructors
 */
export const put = make("PUT")

/**
 * @since 4.0.0
 * @category constructors
 */
export const patch = make("PATCH")

const del = make("DELETE")

export {
  /**
   * @since 4.0.0
   * @category constructors
   */
  del as delete
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const head = make("HEAD")

/**
 * @since 4.0.0
 * @category constructors
 */
export const options = make("OPTIONS")
