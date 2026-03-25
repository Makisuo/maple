/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Parser from "../../SchemaParser.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Rpc from "../rpc/Rpc.ts"
import type * as RpcMessage from "../rpc/RpcMessage.ts"
import type * as RpcSchema from "../rpc/RpcSchema.ts"
import { MalformedMessage } from "./ClusterError.ts"
import type { OutgoingRequest } from "./Message.ts"
import { Snowflake, SnowflakeFromBigInt } from "./Snowflake.ts"

const TypeId = "~effect/cluster/Reply"

/**
 * @since 4.0.0
 * @category guards
 */
export const isReply = (u: unknown): u is Reply<Rpc.Any> => hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export type Reply<R extends Rpc.Any> = WithExit<R> | Chunk<R>

/**
 * @since 4.0.0
 * @category models
 */
export type Encoded = WithExitEncoded | ChunkEncoded

/**
 * @since 4.0.0
 * @category models
 */
export const Encoded: Schema.Codec<Encoded> = Schema.Any as any

/**
 * @since 4.0.0
 * @category models
 */
export class ReplyWithContext<R extends Rpc.Any> extends Data.TaggedClass("ReplyWithContext")<{
  readonly reply: Reply<R>
  readonly services: ServiceMap.ServiceMap<Rpc.Services<R>>
  readonly rpc: R
}> {
  /**
   * @since 4.0.0
   */
  static fromDefect(options: {
    readonly id: Snowflake
    readonly requestId: Snowflake
    readonly defect: unknown
  }): ReplyWithContext<any> {
    return new ReplyWithContext({
      reply: new WithExit({
        requestId: options.requestId,
        id: options.id,
        exit: Exit.die(Schema.encodeSync(Schema.Defect)(options.defect))
      }),
      services: ServiceMap.empty() as any,
      rpc: neverRpc
    })
  }
  /**
   * @since 4.0.0
   */
  static interrupt(options: {
    readonly id: Snowflake
    readonly requestId: Snowflake
  }): ReplyWithContext<any> {
    return new ReplyWithContext({
      reply: new WithExit({
        requestId: options.requestId,
        id: options.id,
        exit: Exit.interrupt()
      }),
      services: ServiceMap.empty() as any,
      rpc: neverRpc
    })
  }
}

const neverRpc = Rpc.make("Never", {
  success: Schema.Never as any,
  error: Schema.Never,
  payload: {}
})

/**
 * @since 4.0.0
 * @category models
 */
export interface WithExitEncoded<A = unknown, E = unknown> {
  readonly _tag: "WithExit"
  readonly requestId: string
  readonly id: string
  readonly exit: RpcMessage.ExitEncoded<A, E>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface ChunkEncoded {
  readonly _tag: "Chunk"
  readonly requestId: string
  readonly id: string
  readonly sequence: number
  readonly values: NonEmptyReadonlyArray<unknown>
}

const schemaCache = new WeakMap<Rpc.Any, Schema.Top>()

/**
 * @since 4.0.0
 * @category models
 */
export class Chunk<R extends Rpc.Any> extends Data.TaggedClass("Chunk")<{
  readonly requestId: Snowflake
  readonly id: Snowflake
  readonly sequence: number
  readonly values: NonEmptyReadonlyArray<Rpc.SuccessChunk<R>>
}> {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static emptyFrom(requestId: Snowflake) {
    return new Chunk({
      requestId,
      id: Snowflake(BigInt(0)),
      sequence: 0,
      values: [undefined]
    })
  }

  /**
   * @since 4.0.0
   */
  static readonly Any = Schema.declare((u): u is Chunk<never> => isReply(u) && u._tag === "Chunk")

  /**
   * @since 4.0.0
   */
  static readonly transform: Transformation.Transformation<any, any> = Transformation.transform({
    decode: (a: any) => new Chunk(a),
    encode: (a) => a as any
  })

  /**
   * @since 4.0.0
   */
  static schema<R extends Rpc.Any>(
    rpc: R
  ): Schema.declareConstructor<Chunk<R>, Chunk<R>, readonly [Rpc.SuccessExitSchema<R>]> {
    const successSchema = ((rpc as any as Rpc.AnyWithProps).successSchema as RpcSchema.Stream<any, any>).success
    if (!successSchema) {
      return Schema.Never as any
    }
    return this.schemaFrom(successSchema) as any
  }

  /**
   * @since 4.0.0
   */
  static schemaFrom<Success extends Schema.Top>(
    success: Success
  ): Schema.declareConstructor<Chunk<Rpc.Any>, Chunk<Rpc.Any>, readonly [Success]> {
    // TODO: extract to a helper function
    return Schema.declareConstructor<Chunk<Rpc.Any>>()(
      [success],
      ([success]) => (input, ast, options) => {
        if (!isReply(input) || input._tag !== "Chunk") {
          return Effect.fail(new Issue.InvalidType(ast, Option.some(input)))
        }
        return Effect.mapBothEager(Parser.decodeEffect(Schema.NonEmptyArray(success))(input.values, options), {
          onFailure: (issue) => new Issue.Composite(ast, Option.some(input), [new Issue.Pointer(["values"], issue)]),
          onSuccess: (values) => new Chunk({ ...input, values } as any)
        })
      },
      {
        expected: "Reply.Chunk",
        toCodecJson: ([success]) =>
          Schema.link<Chunk<Rpc.Any>>()(
            Schema.Struct({
              _tag: Schema.Literal("Chunk"),
              requestId: SnowflakeFromBigInt,
              id: SnowflakeFromBigInt,
              sequence: Schema.Number,
              values: Schema.NonEmptyArray(success)
            }),
            Transformation.transform({
              decode: (encoded) => new Chunk(encoded),
              encode: (result) => ({ ...result })
            })
          )
      }
    )
  }

  /**
   * @since 4.0.0
   */
  withRequestId(requestId: Snowflake): Chunk<R> {
    return new Chunk({
      ...this,
      requestId
    })
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export class WithExit<R extends Rpc.Any> extends Data.TaggedClass("WithExit")<{
  readonly requestId: Snowflake
  readonly id: Snowflake
  readonly exit: Rpc.Exit<R>
}> {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is WithExit<any> {
    return isReply(u) && u._tag === "WithExit"
  }

  /**
   * @since 4.0.0
   */
  static schema<R extends Rpc.Any>(
    rpc: R
  ): Schema.declareConstructor<
    WithExit<R>,
    WithExit<R>,
    readonly [Schema.Exit<Rpc.SuccessExitSchema<R>, Rpc.ErrorExitSchema<R>, Rpc.DefectSchema>]
  > {
    return this.schemaFrom(Rpc.exitSchema(rpc))
  }

  /**
   * @since 4.0.0
   */
  static schemaFrom<Success extends Schema.Top, Error extends Schema.Top, Defect extends Schema.Top>(
    exitSchema: Schema.Exit<Success, Error, Defect>
  ): Schema.declareConstructor<
    WithExit<Rpc.Any>,
    WithExit<Rpc.Any>,
    readonly [Schema.Exit<Success, Error, Defect>]
  > {
    // TODO: extract to a helper function
    return Schema.declareConstructor<WithExit<Rpc.Any>>()(
      [exitSchema],
      ([exit]) => (input, ast, options) => {
        if (!isReply(input) || input._tag !== "WithExit") {
          return Effect.fail(new Issue.InvalidType(ast, Option.some(input)))
        }
        return Effect.mapBothEager(Parser.decodeEffect(exit)(input.exit, options), {
          onFailure: (issue) => new Issue.Composite(ast, Option.some(input), [new Issue.Pointer(["exit"], issue)]),
          onSuccess: (exit) => new WithExit({ ...input, exit: exit as any })
        })
      },
      {
        expected: "Reply.WithExit",
        toCodecJson: ([exit]) =>
          Schema.link<WithExit<Rpc.Any>>()(
            Schema.Struct({
              _tag: Schema.Literal("WithExit"),
              requestId: SnowflakeFromBigInt,
              id: SnowflakeFromBigInt,
              exit
            }),
            Transformation.transform({
              decode: (encoded) => new WithExit(encoded as any),
              encode: (result) => ({ ...result })
            })
          )
      }
    )
  }

  /**
   * @since 4.0.0
   */
  withRequestId(requestId: Snowflake): WithExit<R> {
    return new WithExit({
      ...this,
      requestId
    })
  }
}

/**
 * @since 4.0.0
 * @category schemas
 */
export const Reply = <R extends Rpc.Any>(
  rpc: R
): Schema.Codec<
  WithExit<R> | Chunk<R>,
  Encoded,
  Rpc.ServicesServer<R>,
  Rpc.ServicesClient<R>
> => {
  if (schemaCache.has(rpc)) {
    return schemaCache.get(rpc) as any
  }
  const schema = Schema.toCodecJson(Schema.Union([WithExit.schema(rpc), Chunk.schema(rpc)]))
  schemaCache.set(rpc, schema)
  return schema as any
}

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const serialize = <R extends Rpc.Any>(
  self: ReplyWithContext<R>
): Effect.Effect<Encoded, MalformedMessage> => {
  const schema = Reply(self.rpc)
  return MalformedMessage.refail(
    Effect.provideServices(
      Schema.encodeEffect(schema)(self.reply),
      self.services
    )
  )
}

/**
 * @since 4.0.0
 * @category serialization / deserialization
 */
export const serializeLastReceived = <R extends Rpc.Any>(
  self: OutgoingRequest<R>
): Effect.Effect<Option.Option<Encoded>, MalformedMessage> => {
  const lastReceivedReply = self.lastReceivedReply
  if (lastReceivedReply._tag === "None") {
    return Effect.succeedNone
  }
  const schema = Reply(self.rpc)
  return MalformedMessage.refail(
    Effect.provideServices(Schema.encodeEffect(schema)(lastReceivedReply.value), self.services)
  ).pipe(
    Effect.map(Option.some)
  )
}
