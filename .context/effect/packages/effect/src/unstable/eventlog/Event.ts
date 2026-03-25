/**
 * @since 4.0.0
 */
import { pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as Msgpack from "../encoding/Msgpack.ts"

/**
 * @since 4.0.0
 * @category type ids
 */
export type TypeId = "~effect/eventlog/Event"

/**
 * @since 4.0.0
 * @category type ids
 */
export const TypeId: TypeId = "~effect/eventlog/Event"

/**
 * @since 4.0.0
 * @category guards
 */
export const isEvent = (u: unknown): u is Event<any, any, any, any> => Predicate.hasProperty(u, TypeId)

/**
 * Represents an event in an EventLog.
 *
 * @since 4.0.0
 * @category models
 */
export interface Event<
  out Tag extends string,
  in out Payload extends Schema.Top = typeof Schema.Void,
  in out Success extends Schema.Top = typeof Schema.Void,
  in out Error extends Schema.Top = typeof Schema.Never
> {
  readonly [TypeId]: TypeId
  readonly tag: Tag
  readonly key: string
  readonly primaryKey: (payload: Schema.Schema.Type<Payload>) => string
  readonly payload: Payload
  readonly payloadMsgPack: Msgpack.schema<Payload>
  readonly success: Success
  readonly error: Error
}

/**
 * @since 4.0.0
 * @category models
 */
export interface EventHandler<in out Tag extends string> {
  readonly _: unique symbol
  readonly tag: Tag
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: TypeId
  readonly tag: string
  readonly key: string
  readonly primaryKey: (payload: any) => string
  readonly payload: Schema.Top
  readonly payloadMsgPack: Msgpack.schema<Schema.Top>
  readonly success: Schema.Top
  readonly error: Schema.Top
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AnyWithProps extends Any {}

/**
 * @since 4.0.0
 * @category models
 */
export type ToService<A> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? EventHandler<_Tag> :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type Tag<A> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Tag :
  never

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorSchema<A extends Any> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Error
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Error<A extends Any> = Schema.Schema.Type<ErrorSchema<A>>

/**
 * @since 4.0.0
 * @category models
 */
export type AddError<A extends Any, Error extends Schema.Top> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? Event<_Tag, _Payload, _Success, _Error | Error>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type PayloadSchema<A extends Any> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Payload
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type PayloadSchemaWithTag<A extends Any, Tag extends string> = A extends Event<
  Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Payload
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Payload<A extends Any> = Schema.Schema.Type<PayloadSchema<A>>

/**
 * @since 4.0.0
 * @category models
 */
export type TaggedPayload<A extends Any> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? {
    readonly _tag: _Tag
    readonly payload: Schema.Schema.Type<_Payload>
  }
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessSchema<A extends Any> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Success
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Success<A extends Any> = Schema.Schema.Type<SuccessSchema<A>>

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesClient<A> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesServer<A> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["EncodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Services<A> = A extends Event<
  infer _Tag,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["EncodingServices"]
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type WithTag<Events extends Any, Tag extends string> = Extract<Events, { readonly tag: Tag }>

/**
 * @since 4.0.0
 * @category models
 */
export type ExcludeTag<Events extends Any, Tag extends string> = Exclude<Events, { readonly tag: Tag }>

/**
 * @since 4.0.0
 * @category models
 */
export type PayloadWithTag<Events extends Any, Tag extends string> = Payload<WithTag<Events, Tag>>

/**
 * @since 4.0.0
 * @category models
 */
export type SuccessWithTag<Events extends Any, Tag extends string> = Success<WithTag<Events, Tag>>

/**
 * @since 4.0.0
 * @category models
 */
export type ErrorWithTag<Events extends Any, Tag extends string> = Error<WithTag<Events, Tag>>

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesClientWithTag<Events extends Any, Tag extends string> = ServicesClient<WithTag<Events, Tag>>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export function make<
  Tag extends string,
  Payload extends Schema.Top = typeof Schema.Void,
  Success extends Schema.Top = typeof Schema.Void,
  Error extends Schema.Top = typeof Schema.Never
>(options: {
  readonly tag: Tag
  readonly primaryKey: (payload: Schema.Schema.Type<Payload>) => string
  readonly payload?: Payload | undefined
  readonly success?: Success | undefined
  readonly error?: Error | undefined
}): Event<Tag, Payload, Success, Error>
export function make(options: {
  readonly tag: string
  readonly primaryKey: (payload: Schema.Schema.Type<Schema.Top>) => string
  readonly payload?: Schema.Top | undefined
  readonly success?: Schema.Top | undefined
  readonly error?: Schema.Top | undefined
}): Event<string, Schema.Top, Schema.Top, typeof Schema.Never> {
  const payload = options.payload ?? Schema.Void
  const success = options.success ?? Schema.Void
  const error = options.error ?? Schema.Never
  return Object.assign(Object.create(Proto), {
    tag: options.tag,
    key: serviceKey(options.tag),
    primaryKey: options.primaryKey,
    payload,
    payloadMsgPack: Msgpack.schema(payload),
    success,
    error
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export function addError<A extends Any, Error2 extends Schema.Top>(
  event: A,
  error: Error2
): AddError<A, Error2>
export function addError(event: Any, error: Schema.Top): Any {
  return make({
    tag: event.tag,
    primaryKey: event.primaryKey,
    payload: event.payload,
    success: event.success,
    error: Schema.Union([event.error, error])
  })
}

/**
 * @since 4.0.0
 */
export const serviceKey = (tag: string): string => `effect/eventlog/Event/${tag}`
