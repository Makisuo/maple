/**
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import type { Effect } from "../../Effect.ts"
import type { Exit as Exit_ } from "../../Exit.ts"
import * as Option from "../../Option.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import type * as Queue from "../../Queue.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { Stream } from "../../Stream.ts"
import type * as Struct from "../../Struct.ts"
import type { Headers } from "../http/Headers.ts"
import type { RequestId } from "./RpcMessage.ts"
import type * as RpcMiddleware from "./RpcMiddleware.ts"
import * as RpcSchema from "./RpcSchema.ts"

const TypeId = "~effect/rpc/Rpc"

/**
 * @since 4.0.0
 * @category guards
 */
export const isRpc = (u: unknown): u is Rpc<any, any, any> => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export interface DefectSchema extends Schema.Top {
  readonly Type: unknown
  makeUnsafe(input: null, options?: Schema.MakeOptions): unknown
  makeUnsafe(input: undefined, options?: Schema.MakeOptions): unknown
  makeUnsafe(input: {}, options?: Schema.MakeOptions): unknown
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * Represents an API endpoint. An API endpoint is mapped to a single route on
 * the underlying `HttpRouter`.
 *
 * @since 4.0.0
 * @category models
 */
export interface Rpc<
  in out Tag extends string,
  out Payload extends Schema.Top = Schema.Void,
  out Success extends Schema.Top = Schema.Void,
  out Error extends Schema.Top = Schema.Never,
  out Middleware extends RpcMiddleware.AnyService = never,
  out Requires = never
> extends Pipeable {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly _tag: Tag
  readonly key: string
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly defectSchema: Schema.Top
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly middlewares: ReadonlySet<Middleware>
  readonly "~requires": Requires

  /**
   * Set the schema for the success response of the rpc.
   */
  setSuccess<S extends Schema.Top>(schema: S): Rpc<
    Tag,
    Payload,
    S,
    Error,
    Middleware,
    Requires
  >

  /**
   * Set the schema for the error response of the rpc.
   */
  setError<E extends Schema.Top>(schema: E): Rpc<
    Tag,
    Payload,
    Success,
    E,
    Middleware,
    Requires
  >

  /**
   * Set the schema for the payload of the rpc.
   */
  setPayload<P extends Schema.Top | Schema.Struct.Fields>(
    schema: P
  ): Rpc<
    Tag,
    P extends Schema.Struct.Fields ? Schema.Struct<P> : P,
    Success,
    Error,
    Middleware,
    Requires
  >

  /**
   * Add an `RpcMiddleware` to this procedure.
   */
  middleware<M extends RpcMiddleware.AnyService>(middleware: M): Rpc<
    Tag,
    Payload,
    Success,
    Error,
    Middleware | M,
    RpcMiddleware.ApplyServices<M["Identifier"], Requires>
  >

  /**
   * Set the schema for the error response of the rpc.
   */
  prefix<const Prefix extends string>(prefix: Prefix): Rpc<
    `${Prefix}${Tag}`,
    Payload,
    Success,
    Error,
    Middleware,
    Requires
  >

  /**
   * Add an annotation on the rpc.
   */
  annotate<I, S>(
    tag: ServiceMap.Key<I, S>,
    value: S
  ): Rpc<Tag, Payload, Success, Error, Middleware, Requires>

  /**
   * Merge the annotations of the rpc with the provided annotations.
   */
  annotateMerge<I>(
    annotations: ServiceMap.ServiceMap<I>
  ): Rpc<Tag, Payload, Success, Error, Middleware, Requires>
}

/**
 * Represents an implemented rpc.
 *
 * @since 4.0.0
 * @category models
 */
export interface Handler<Tag extends string> {
  readonly _: unique symbol
  readonly tag: Tag
  readonly handler: (request: any, options: {
    readonly clientId: number
    readonly requestId: RequestId
    readonly headers: Headers
    readonly rpc: Any
  }) => Effect<any, any> | Stream<any, any>
  readonly services: ServiceMap.ServiceMap<never>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly _tag: string
  readonly key: string
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyWithProps extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly _tag: string
  readonly key: string
  readonly payloadSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly defectSchema: Schema.Top
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly middlewares: ReadonlySet<RpcMiddleware.AnyServiceWithProps>
  readonly "~requires": any
}

/**
 * @since 4.0.0
 * @category models
 */
export type Tag<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Tag
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessSchema<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Success
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Success<R> = SuccessSchema<R>["Type"]

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessEncoded<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Success["Encoded"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessExitSchema<R> = SuccessSchema<R> extends RpcSchema.Stream<infer _A, infer _E> ? _A : SuccessSchema<R>

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessExit<R> = Success<R> extends infer T ? T extends Stream<infer _A, infer _E, infer _Env> ? void : T
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessChunk<R> = Success<R> extends Stream<infer _A, infer _E, infer _Env> ? _A : never

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorSchema<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Error | _Middleware["error"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Error<R> = Schema.Schema.Type<ErrorSchema<R>>

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorExitSchema<R> = SuccessSchema<R> extends RpcSchema.Stream<infer _A, infer _E> ? _E | ErrorSchema<R>
  : ErrorSchema<R>

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorExit<R> = Success<R> extends Stream<infer _A, infer _E, infer _Env> ? _E | Error<R> : Error<R>

/**
 * @since 4.0.0
 * @category models
 */
export type Exit<R> = Exit_<SuccessExit<R>, ErrorExit<R>>

/**
 * @since 4.0.0
 * @category models
 */
export type PayloadConstructor<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Payload["~type.make.in"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Payload<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Payload["Type"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Services<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ?
    | _Payload["DecodingServices"]
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["DecodingServices"]
    | _Error["EncodingServices"]
    | _Middleware["error"]["DecodingServices"]
    | _Middleware["error"]["EncodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesClient<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ?
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
    | _Middleware["error"]["DecodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesServer<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ?
    | _Payload["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["EncodingServices"]
    | _Middleware["error"]["EncodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Middleware<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? ServiceMap.Service.Identifier<_Middleware>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type MiddlewareClient<R> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Middleware extends { readonly requiredForClient: true } ? RpcMiddleware.ForClient<_Middleware["Identifier"]>
  : never
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type AddError<R extends Any, Error extends Schema.Top> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? Rpc<
    _Tag,
    _Payload,
    _Success,
    _Error | Error,
    _Middleware,
    _Requires
  > :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type AddMiddleware<R extends Any, Middleware extends RpcMiddleware.AnyService> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? Rpc<
    _Tag,
    _Payload,
    _Success,
    _Error,
    _Middleware | Middleware,
    RpcMiddleware.ApplyServices<Middleware["Identifier"], _Requires>
  > :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ToHandler<R extends Any> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? Handler<_Tag> :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ToHandlerFn<Current extends Any, R = any> = (
  payload: Payload<Current>,
  options: {
    readonly clientId: number
    readonly requestId: RequestId
    readonly headers: Headers
    readonly rpc: Current
  }
) => ResultFrom<Current, R> | Wrapper<ResultFrom<Current, R>>

/**
 * @since 4.0.0
 * @category models
 */
export type IsStream<R extends Any, Tag extends string> = R extends Rpc<
  Tag,
  infer _Payload,
  RpcSchema.Stream<infer _A, infer _E>,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? true :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ExtractTag<R extends Any, Tag extends string> = R extends Rpc<
  Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? R :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ExtractProvides<R extends Any, Tag extends string> = R extends Rpc<
  Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? RpcMiddleware.Provides<_Middleware["Identifier"]> :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ExtractRequires<R extends Any, Tag extends string> = R extends Rpc<
  Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? _Requires :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ExcludeProvides<Env, R extends Any, Tag extends string> = Exclude<
  Env,
  ExtractProvides<R, Tag>
>

/**
 * @since 4.0.0
 * @category models
 */
export type ResultFrom<R extends Any, Services> = R extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? [_Success] extends [RpcSchema.Stream<infer _SA, infer _SE>] ?
      | Stream<
        _SA["Type"],
        _SE["Type"] | _Error["Type"],
        Services
      >
      | Effect<
        Queue.Dequeue<_SA["Type"], _SE["Type"] | _Error["Type"] | Cause.Done>,
        _SE["Type"] | Schema.Schema.Type<_Error>,
        Services
      > :
  Effect<
    _Success["Type"],
    _Error["Type"],
    Services
  > :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type Prefixed<Rpcs extends Any, Prefix extends string> = Rpcs extends Rpc<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Middleware,
  infer _Requires
> ? Rpc<
    `${Prefix}${_Tag}`,
    _Payload,
    _Success,
    _Error,
    _Middleware,
    _Requires
  >
  : never

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  setSuccess(
    this: AnyWithProps,
    successSchema: Schema.Top
  ) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      annotations: this.annotations,
      middlewares: this.middlewares
    })
  },
  setError(this: AnyWithProps, errorSchema: Schema.Top) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema,
      defectSchema: this.defectSchema,
      annotations: this.annotations,
      middlewares: this.middlewares
    })
  },
  setPayload(this: AnyWithProps, payloadSchema: Schema.Struct<any> | Schema.Struct.Fields) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: Schema.isSchema(payloadSchema) ? payloadSchema as any : Schema.Struct(payloadSchema as any),
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      annotations: this.annotations,
      middlewares: this.middlewares
    })
  },
  middleware(this: AnyWithProps, middleware: RpcMiddleware.AnyService) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      annotations: this.annotations,
      middlewares: new Set([...this.middlewares, middleware])
    })
  },
  prefix(this: AnyWithProps, prefix: string) {
    return makeProto({
      _tag: `${prefix}${this._tag}`,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      annotations: this.annotations,
      middlewares: this.middlewares
    })
  },
  annotate(this: AnyWithProps, tag: ServiceMap.Key<any, any>, value: any) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      middlewares: this.middlewares,
      annotations: ServiceMap.add(this.annotations, tag, value)
    })
  },
  annotateMerge(this: AnyWithProps, context: ServiceMap.ServiceMap<any>) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      defectSchema: this.defectSchema,
      middlewares: this.middlewares,
      annotations: ServiceMap.merge(this.annotations, context)
    })
  }
}

const makeProto = <
  const Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires
>(options: {
  readonly _tag: Tag
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly defectSchema: Schema.Top
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly middlewares: ReadonlySet<Middleware>
}): Rpc<Tag, Payload, Success, Error, Middleware, Requires> => {
  function Rpc() {}
  Object.setPrototypeOf(Rpc, Proto)
  Object.assign(Rpc, options)
  Rpc.key = `effect/rpc/Rpc/${options._tag}`
  return Rpc as any
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <
  const Tag extends string,
  Payload extends Schema.Top | Schema.Struct.Fields = Schema.Void,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
  const Stream extends boolean = false
>(tag: Tag, options?: {
  readonly payload?: Payload
  readonly success?: Success
  readonly error?: Error
  readonly defect?: DefectSchema
  readonly stream?: Stream
  readonly primaryKey?: [Payload] extends [Schema.Struct.Fields] ? ((
      payload: Payload extends Schema.Struct.Fields ? Struct.Simplify<Schema.Struct<Payload>["Type"]> : Payload["Type"]
    ) => string) :
    never
}): Rpc<
  Tag,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Stream extends true ? RpcSchema.Stream<Success, Error> : Success,
  Stream extends true ? typeof Schema.Never : Error
> => {
  const successSchema = options?.success ?? Schema.Void
  const errorSchema = options?.error ?? Schema.Never
  const defectSchema = options?.defect ?? Schema.Defect
  let payloadSchema: any
  if (options?.primaryKey) {
    payloadSchema = class Payload extends Schema.Class<Payload>(`effect/rpc/Rpc/${tag}`)(options.payload as any) {
      [PrimaryKey.symbol](): string {
        return options.primaryKey!(this as any)
      }
    }
  } else {
    payloadSchema = Schema.isSchema(options?.payload)
      ? options?.payload as any
      : options?.payload
      ? Schema.Struct(options?.payload as any)
      : Schema.Void
  }
  return makeProto({
    _tag: tag,
    payloadSchema,
    successSchema: options?.stream ?
      RpcSchema.Stream(successSchema, errorSchema) :
      successSchema,
    errorSchema: options?.stream ? Schema.Never : errorSchema,
    defectSchema,
    annotations: ServiceMap.empty(),
    middlewares: new Set<never>()
  }) as any
}

const exitSchemaCache = new WeakMap<Any, Schema.Exit<Schema.Top, Schema.Top, DefectSchema>>()

/**
 * @since 4.0.0
 * @category constructors
 */
export const exitSchema = <R extends Any>(
  self: R
): Schema.Exit<
  SuccessExitSchema<R>,
  ErrorExitSchema<R>,
  DefectSchema
> => {
  if (exitSchemaCache.has(self)) {
    return exitSchemaCache.get(self) as any
  }
  const rpc = self as any as AnyWithProps
  const failures = new Set<Schema.Top>([rpc.errorSchema])
  const streamSchemas = RpcSchema.getStreamSchemas(rpc.successSchema)
  if (Option.isSome(streamSchemas)) {
    failures.add(streamSchemas.value.error)
  }
  for (const middleware of rpc.middlewares) {
    failures.add(middleware.error)
  }
  const schema = Schema.Exit(
    Option.isSome(streamSchemas) ? Schema.Void : rpc.successSchema,
    Schema.Union([...failures]),
    rpc.defectSchema
  )
  exitSchemaCache.set(self, schema as any)
  return schema as any
}

const WrapperTypeId = "~effect/rpc/Rpc/Wrapper"

/**
 * @since 4.0.0
 * @category Wrapper
 */
export interface Wrapper<A> {
  readonly [WrapperTypeId]: typeof WrapperTypeId
  readonly value: A
  readonly fork: boolean
  readonly uninterruptible: boolean
}

/**
 * @since 4.0.0
 * @category Wrapper
 */
export const isWrapper = (u: object): u is Wrapper<any> => WrapperTypeId in u

/**
 * @since 4.0.0
 * @category Wrapper
 */
export const wrap = (options: {
  readonly fork?: boolean | undefined
  readonly uninterruptible?: boolean | undefined
}) =>
<A extends object>(value: A): Wrapper<A> =>
  isWrapper(value) ?
    {
      [WrapperTypeId]: WrapperTypeId,
      value: value.value,
      fork: options.fork ?? value.fork,
      uninterruptible: options.uninterruptible ?? value.uninterruptible
    } :
    {
      [WrapperTypeId]: WrapperTypeId,
      value,
      fork: options.fork ?? false,
      uninterruptible: options.uninterruptible ?? false
    }

/**
 * You can use `fork` to wrap a response Effect or Stream, to ensure that the
 * response is executed concurrently regardless of the RpcServer concurrency
 * setting.
 *
 * @since 4.0.0
 * @category Wrapper
 */
export const fork: <A extends object>(value: A) => Wrapper<A> = wrap({ fork: true })

/**
 * You can use `uninterruptible` to wrap a response Effect or Stream, to ensure that it is run in an uninterruptible region.
 *
 * @since 4.0.0
 * @category Wrapper
 */
export const uninterruptible: <A extends object>(value: A) => Wrapper<A> = wrap({ uninterruptible: true })
