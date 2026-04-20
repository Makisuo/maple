/**
 * @since 4.0.0
 */
import type { NoSuchElementError } from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Schema from "../../Schema.ts"
import * as Transferable from "../workers/Transferable.ts"
import type { Protocol } from "./RpcServer.ts"

/**
 * @since 4.0.0
 * @category initial message
 */
export class InitialMessage extends Context.Service<
  InitialMessage,
  Effect.Effect<
    readonly [
      data: unknown,
      transfers: ReadonlyArray<Transferable>
    ]
  >
>()("effect/rpc/RpcWorker/InitialMessage") {}

/**
 * @since 4.0.0
 * @category initial message
 */
export declare namespace InitialMessage {
  /**
   * @since 4.0.0
   * @category initial message
   */
  export interface Encoded {
    readonly _tag: "InitialMessage"
    readonly value: unknown
  }
}

const ProtocolTag: typeof Protocol = Context.Service("@effect/rpc/RpcServer/Protocol") as any

/**
 * @since 4.0.0
 * @category initial message
 */
export const makeInitialMessage = <S extends Schema.Top, E, R2>(
  schema: S,
  effect: Effect.Effect<S["Type"], E, R2>
): Effect.Effect<
  readonly [data: unknown, transferables: ReadonlyArray<globalThis.Transferable>],
  E | Schema.SchemaError,
  S["EncodingServices"] | R2
> => {
  const schemaJson = Schema.toCodecJson(schema)
  return Effect.flatMap(effect, (value) => {
    const collector = Transferable.makeCollectorUnsafe()
    return Schema.encodeEffect(schemaJson)(value).pipe(
      Effect.provideService(Transferable.Collector, collector),
      Effect.map((encoded) => [encoded, collector.clearUnsafe()] as const)
    )
  })
}

/**
 * @since 4.0.0
 * @category initial message
 */
export const layerInitialMessage = <S extends Schema.Top, R2>(
  schema: S,
  build: Effect.Effect<S["Type"], never, R2>
): Layer.Layer<InitialMessage, never, S["EncodingServices"] | R2> =>
  Layer.effect(InitialMessage)(
    Effect.contextWith((context: Context.Context<S["EncodingServices"] | R2>) =>
      Effect.succeed(
        Effect.provideContext(Effect.orDie(makeInitialMessage(schema, build)), context)
      )
    )
  )

/**
 * @since 4.0.0
 * @category initial message
 */
export const initialMessage = <S extends Schema.Top>(
  schema: S
): Effect.Effect<S["Type"], NoSuchElementError | Schema.SchemaError, Protocol | S["DecodingServices"]> =>
  ProtocolTag.asEffect().pipe(
    Effect.flatMap((protocol) => protocol.initialMessage),
    Effect.flatMap((o) => o.asEffect()),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema)))
  )
