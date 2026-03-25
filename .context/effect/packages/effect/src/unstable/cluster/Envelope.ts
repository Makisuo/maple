/**
 * @since 4.0.0
 */
import * as Predicate from "../../Predicate.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Schema from "../../Schema.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as Headers from "../http/Headers.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import { EntityAddress } from "./EntityAddress.ts"
import { type Snowflake, SnowflakeFromBigInt } from "./Snowflake.ts"

/**
 * @since 4.0.0
 * @category Type IDs
 */
export const TypeId = "~effect/cluster/Envelope"

/**
 * @since 4.0.0
 * @category models
 */
export type Envelope<R extends Rpc.Any> = Request<R> | AckChunk | Interrupt

/**
 * @since 4.0.0
 * @category models
 */
export type Encoded = PartialRequestEncoded | AckChunkEncoded | InterruptEncoded

/**
 * @since 4.0.0
 */
export declare namespace Envelope {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Any = Envelope<any>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Request<in out Rpc extends Rpc.Any> {
  readonly [TypeId]: typeof TypeId
  readonly _tag: "Request"
  readonly requestId: Snowflake
  readonly address: EntityAddress
  readonly tag: Rpc.Tag<Rpc>
  readonly payload: Rpc.Payload<Rpc>
  readonly headers: Headers.Headers
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * @since 4.0.0
 * @category models
 */
export class PartialRequest extends Schema.Opaque<PartialRequest>()(Schema.Struct({
  _tag: Schema.tag("Request"),
  requestId: SnowflakeFromBigInt,
  address: EntityAddress,
  tag: Schema.String,
  payload: Schema.Any,
  headers: Headers.HeadersSchema,
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean)
})) {}

/**
 * @since 4.0.0
 * @category models
 */
export interface PartialRequestEncoded {
  readonly _tag: "Request"
  readonly requestId: string
  readonly address: {
    readonly shardId: {
      readonly group: string
      readonly id: number
    }
    readonly entityType: string
    readonly entityId: string
  }
  readonly tag: string
  readonly payload: unknown
  readonly headers: ReadonlyRecord<string, string>
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * @since 4.0.0
 * @category models
 */
export class AckChunk extends Schema.Class<AckChunk>("effect/cluster/Envelope/AckChunk")({
  _tag: Schema.tag("AckChunk"),
  id: SnowflakeFromBigInt,
  address: EntityAddress,
  requestId: SnowflakeFromBigInt,
  replyId: SnowflakeFromBigInt
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  withRequestId(requestId: Snowflake): AckChunk {
    return new AckChunk({
      ...this,
      requestId
    })
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export interface AckChunkEncoded {
  readonly _tag: "AckChunk"
  readonly id: string
  readonly address: {
    readonly shardId: {
      readonly group: string
      readonly id: number
    }
    readonly entityType: string
    readonly entityId: string
  }
  readonly requestId: string
  readonly replyId: string
}

/**
 * @since 4.0.0
 * @category models
 */
export class Interrupt extends Schema.Class<Interrupt>("effect/cluster/Envelope/Interrupt")({
  _tag: Schema.tag("Interrupt"),
  id: SnowflakeFromBigInt,
  address: EntityAddress,
  requestId: SnowflakeFromBigInt
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  withRequestId(requestId: Snowflake): Interrupt {
    return new Interrupt({
      ...this,
      requestId
    })
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export interface InterruptEncoded {
  readonly _tag: "Interrupt"
  readonly id: string
  readonly address: {
    readonly shardId: {
      readonly group: string
      readonly id: number
    }
    readonly entityType: string
    readonly entityId: string
  }
  readonly requestId: string
}

/**
 * @since 4.0.0
 * @category schemas
 */
export const Partial: Schema.Union<
  readonly [
    typeof PartialRequest,
    typeof AckChunk,
    typeof Interrupt
  ]
> = Schema.Union([PartialRequest, AckChunk, Interrupt])

/**
 * @since 4.0.0
 * @category schemas
 */
export type Partial = typeof Partial.Type

/**
 * @since 4.0.0
 * @category schemas
 */
export const PartialJson: Schema.Codec<
  AckChunk | Interrupt | PartialRequest,
  Encoded
> = Schema.toCodecJson(Partial) as any

/**
 * @since 4.0.0
 * @category schemas
 */
export const PartialArray: Schema.mutable<
  Schema.$Array<Schema.Codec<AckChunk | Interrupt | PartialRequest, Encoded>>
> = Schema.mutable(Schema.Array(PartialJson))

/**
 * @since 4.0.0
 */
export declare namespace Request {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Any = Request<any>
}

/**
 * @since 4.0.0
 * @category refinements
 */
export const isEnvelope = (u: unknown): u is Envelope<any> => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeRequest = <Rpc extends Rpc.Any>(
  options: {
    readonly requestId: Snowflake
    readonly address: EntityAddress
    readonly tag: Rpc.Tag<Rpc>
    readonly payload: Rpc.Payload<Rpc>
    readonly headers: Headers.Headers
    readonly traceId?: string | undefined
    readonly spanId?: string | undefined
    readonly sampled?: boolean | undefined
  }
): Request<Rpc> => ({
  [TypeId]: TypeId,
  _tag: "Request",
  requestId: options.requestId,
  tag: options.tag,
  address: options.address,
  payload: options.payload,
  headers: options.headers,
  ...(options.traceId !== undefined ?
    {
      traceId: options.traceId!,
      spanId: options.spanId!,
      sampled: options.sampled!
    } :
    {})
})

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const Envelope = Schema.declare(isEnvelope, {
  identifier: "Envelope"
})

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const Request = Schema.declare(
  (u): u is Request.Any => isEnvelope(u) && u._tag === "Request",
  { identifier: "Request" }
)

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const RequestTransform: Transformation.Transformation<
  Request.Any,
  any
> = Transformation.transform({
  decode: (u: any) => makeRequest(u),
  encode: (u) => u as any
})

/**
 * @since 4.0.0
 * @category primary key
 */
export const primaryKey = <R extends Rpc.Any>(envelope: Envelope<R>): string | null => {
  if (envelope._tag !== "Request" || !PrimaryKey.isPrimaryKey(envelope.payload)) {
    return null
  }
  return primaryKeyByAddress({
    address: envelope.address,
    tag: envelope.tag,
    id: PrimaryKey.value(envelope.payload)
  })
}

/**
 * @since 4.0.0
 * @category primary key
 */
export const primaryKeyByAddress = (options: {
  readonly address: EntityAddress
  readonly tag: string
  readonly id: string
}): string =>
  // hash the entity address to save space?
  `${options.address.entityType}/${options.address.entityId}/${options.tag}/${options.id}`
