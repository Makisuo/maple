/**
 * @since 4.0.0
 */
import { Packr, Unpackr } from "msgpackr"
import * as Msgpackr from "msgpackr"
import * as Arr from "../../Array.ts"
import * as Channel from "../../Channel.ts"
import * as ChannelSchema from "../../ChannelSchema.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Pull from "../../Pull.ts"
import * as Schema from "../../Schema.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Transformation from "../../SchemaTransformation.ts"

const MsgPackErrorTypeId = "~effect/encoding/MsgPack/MsgPackError"

/**
 * @since 4.0.0
 * @category errors
 */
export class MsgPackError extends Data.TaggedError("MsgPackError")<{
  readonly kind: "Pack" | "Unpack"
  readonly cause: unknown
}> {
  /**
   * @since 4.0.0
   */
  readonly [MsgPackErrorTypeId] = MsgPackErrorTypeId

  /**
   * @since 4.0.0
   */
  override get message() {
    return this.kind
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const encode = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE | MsgPackError,
  Done,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      const packr = new Packr()
      return Effect.flatMap(upstream, (chunk) => {
        try {
          return Effect.succeed(Arr.map(chunk, (item) => packr.pack(item) as Uint8Array<ArrayBuffer>))
        } catch (cause) {
          return Effect.fail(new MsgPackError({ kind: "Pack", cause }))
        }
      })
    })
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const encodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  MsgPackError | Schema.SchemaError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE,
  Done,
  S["EncodingServices"]
> => Channel.pipeTo(ChannelSchema.encode(schema)(), encode())

/**
 * @since 4.0.0
 * @category constructors
 */
export const decode = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  IE | MsgPackError,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      const unpackr = new Unpackr()
      let incomplete: Uint8Array<ArrayBuffer> | undefined = undefined
      return Effect.flatMap(
        upstream,
        function loop(chunk): Pull.Pull<Arr.NonEmptyReadonlyArray<unknown>, IE | MsgPackError, Done> {
          const out = Arr.empty<unknown>()
          for (let i = 0; i < chunk.length; i++) {
            let buf = chunk[i]
            if (incomplete !== undefined) {
              const prev = buf
              buf = new Uint8Array(incomplete.length + buf.length)
              buf.set(incomplete)
              buf.set(prev, incomplete.length)
              incomplete = undefined
            }
            try {
              out.push(...unpackr.unpackMultiple(buf))
            } catch (cause) {
              const error: any = cause
              if (error.incomplete) {
                incomplete = buf.subarray(error.lastPosition)
                if (error.values) {
                  out.push(...error.values)
                }
              } else {
                return Effect.fail(new MsgPackError({ kind: "Unpack", cause }))
              }
            }
          }
          return Arr.isReadonlyArrayNonEmpty(out) ? Effect.succeed(out) : Effect.flatMap(upstream, loop)
        }
      )
    })
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const decodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  Schema.SchemaError | MsgPackError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE,
  Done,
  S["DecodingServices"]
> => Channel.pipeTo(decode<IE, Done>(), ChannelSchema.decodeUnknown(schema)())

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplex = <R, IE, OE, OutDone, InDone>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    IE | MsgPackError,
    InDone,
    R
  >
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  MsgPackError | OE,
  OutDone,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  InDone,
  R
> =>
  encode<IE, InDone>().pipe(
    Channel.pipeTo(self),
    Channel.pipeTo(decode())
  )

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplexSchema: {
  <In extends Schema.Top, Out extends Schema.Top>(
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      MsgPackError | Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    MsgPackError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      MsgPackError | Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    MsgPackError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = dual(2, <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    MsgPackError | Schema.SchemaError | InErr,
    InDone,
    R
  >,
  options: {
    readonly inputSchema: In
    readonly outputSchema: Out
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Out["Type"]>,
  MsgPackError | Schema.SchemaError | OutErr,
  OutDone,
  Arr.NonEmptyReadonlyArray<In["Type"]>,
  InErr,
  InDone,
  R | In["EncodingServices"] | Out["DecodingServices"]
> => ChannelSchema.duplexUnknown(duplex(self), options))

/**
 * @since 4.0.0
 * @category schemas
 */
export interface schema<S extends Schema.Top> extends Schema.decodeTo<S, Schema.instanceOf<Uint8Array<ArrayBuffer>>> {}

/**
 * @since 4.0.0
 * @category schemas
 */
export const transformation: Transformation.Transformation<
  unknown,
  Uint8Array<ArrayBuffer>
> = Transformation.transformOrFail({
  decode(e, _options) {
    try {
      return Effect.succeed(Msgpackr.decode(e))
    } catch (cause) {
      return Effect.fail(
        new Issue.InvalidValue(Option.some(e), {
          message: Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause)
        })
      )
    }
  },
  encode(t, _options) {
    try {
      return Effect.succeed(Msgpackr.encode(t) as Uint8Array<ArrayBuffer>)
    } catch (cause) {
      return Effect.fail(
        new Issue.InvalidValue(Option.some(t), {
          message: Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause)
        })
      )
    }
  }
})

/**
 * @since 4.0.0
 * @category schemas
 */
export const schema = <S extends Schema.Top>(schema: S): schema<S> =>
  (Schema.Uint8Array as Schema.instanceOf<Uint8Array<ArrayBuffer>>).pipe(
    Schema.decodeTo(schema, transformation)
  )
