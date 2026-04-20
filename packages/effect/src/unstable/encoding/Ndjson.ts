/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Channel from "../../Channel.ts"
import * as ChannelSchema from "../../ChannelSchema.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import { dual, identity } from "../../Function.ts"
import type * as Schema from "../../Schema.ts"

const NdjsonErrorTypeId = "~effect/encoding/Ndjson/NdjsonError"

const encoder = new TextEncoder()

/**
 * @since 4.0.0
 * @category errors
 */
export class NdjsonError extends Data.TaggedError("NdjsonError")<{
  readonly kind: "Pack" | "Unpack"
  readonly cause: unknown
}> {
  /**
   * @since 4.0.0
   */
  readonly [NdjsonErrorTypeId] = NdjsonErrorTypeId

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
export const encodeString = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<string>,
  IE | NdjsonError,
  Done,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.succeed(Effect.flatMap(upstream, (input) => {
      try {
        return Effect.succeed(Arr.of(input.map((item) => JSON.stringify(item)).join("\n") + "\n"))
      } catch (cause) {
        return Effect.fail(new NdjsonError({ kind: "Pack", cause }))
      }
    }))
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const encode = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  IE | NdjsonError,
  Done,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  Done
> => Channel.map(encodeString(), Arr.map((_) => encoder.encode(_)))

/**
 * @since 4.0.0
 * @category constructors
 */
export const encodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  NdjsonError | Schema.SchemaError | IE,
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
export const encodeSchemaString = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<string>,
  NdjsonError | Schema.SchemaError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE,
  Done,
  S["EncodingServices"]
> => Channel.pipeTo(ChannelSchema.encode(schema)(), encodeString())

/**
 * @since 4.0.0
 * @category constructors
 */
export const decodeString = <IE = never, Done = unknown>(options?: {
  readonly ignoreEmptyLines?: boolean | undefined
}): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  IE | NdjsonError,
  Done,
  Arr.NonEmptyReadonlyArray<string>,
  IE,
  Done
> => {
  const lines = Channel.splitLines<IE, Done>().pipe(
    options?.ignoreEmptyLines === true ?
      Channel.filterArray((line) => line.length > 0) :
      identity
  )
  return Channel.mapEffect(lines, (chunk) => {
    try {
      return Effect.succeed(Arr.map(chunk, (line) => JSON.parse(line)))
    } catch (cause) {
      return Effect.fail(new NdjsonError({ kind: "Unpack", cause }))
    }
  })
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const decode = <IE = never, Done = unknown>(options?: {
  readonly ignoreEmptyLines?: boolean | undefined
}): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  IE | NdjsonError,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  IE,
  Done
> => {
  return Channel.pipeTo(Channel.decodeText(), decodeString(options))
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const decodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(options?: {
  readonly ignoreEmptyLines?: boolean | undefined
}): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  Schema.SchemaError | NdjsonError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  IE,
  Done,
  S["DecodingServices"]
> => Channel.pipeTo(decode(options), ChannelSchema.decodeUnknown(schema)())

/**
 * @since 4.0.0
 * @category constructors
 */
export const decodeSchemaString = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(options?: {
  readonly ignoreEmptyLines?: boolean | undefined
}): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  Schema.SchemaError | NdjsonError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<string>,
  IE,
  Done,
  S["DecodingServices"]
> => Channel.pipeTo(decodeString(options), ChannelSchema.decodeUnknown(schema)())

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplex: {
  (options?: {
    readonly ignoreEmptyLines?: boolean | undefined
  }): <R, IE, OE, OutDone, InDone>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      OE,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      IE | NdjsonError,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<unknown>,
    NdjsonError | OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<unknown>,
    IE,
    InDone,
    R
  >
  <R, IE, OE, OutDone, InDone>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      OE,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      IE | NdjsonError,
      InDone,
      R
    >,
    options?: {
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<unknown>,
    NdjsonError | OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<unknown>,
    IE,
    InDone,
    R
  >
} = dual((args) => Channel.isChannel(args[0]), <R, IE, OE, OutDone, InDone>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array>,
    OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array>,
    IE | NdjsonError,
    InDone,
    R
  >,
  options?: {
    readonly ignoreEmptyLines?: boolean | undefined
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  NdjsonError | OE,
  OutDone,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  InDone,
  R
> =>
  Channel.pipeTo(
    Channel.pipeTo(encode(), self),
    decode(options)
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplexString: {
  (options?: {
    readonly ignoreEmptyLines?: boolean | undefined
  }): <R, IE, OE, OutDone, InDone>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<string>,
      OE,
      OutDone,
      Arr.NonEmptyReadonlyArray<string>,
      IE | NdjsonError,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<unknown>,
    NdjsonError | OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<unknown>,
    IE,
    InDone,
    R
  >
  <R, IE, OE, OutDone, InDone>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<string>,
      OE,
      OutDone,
      Arr.NonEmptyReadonlyArray<string>,
      IE | NdjsonError,
      InDone,
      R
    >,
    options?: {
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<unknown>,
    NdjsonError | OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<unknown>,
    IE,
    InDone,
    R
  >
} = dual((args) => Channel.isChannel(args[0]), <R, IE, OE, OutDone, InDone>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<string>,
    OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<string>,
    IE | NdjsonError,
    InDone,
    R
  >,
  options?: {
    readonly ignoreEmptyLines?: boolean | undefined
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  NdjsonError | OE,
  OutDone,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  InDone,
  R
> =>
  Channel.pipeTo(
    Channel.pipeTo(encodeString(), self),
    decodeString(options)
  ))

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplexSchema: {
  <In extends Schema.Top, Out extends Schema.Top>(
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      NdjsonError | Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    NdjsonError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array>,
      NdjsonError | Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    NdjsonError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = dual(2, <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array>,
    OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array>,
    NdjsonError | Schema.SchemaError | InErr,
    InDone,
    R
  >,
  options: {
    readonly inputSchema: In
    readonly outputSchema: Out
    readonly ignoreEmptyLines?: boolean | undefined
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Out["Type"]>,
  NdjsonError | Schema.SchemaError | OutErr,
  OutDone,
  Arr.NonEmptyReadonlyArray<In["Type"]>,
  InErr,
  InDone,
  R | In["EncodingServices"] | Out["DecodingServices"]
> => ChannelSchema.duplexUnknown(duplex(self, options), options))

/**
 * @since 4.0.0
 * @category combinators
 */
export const duplexSchemaString: {
  <In extends Schema.Top, Out extends Schema.Top>(
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<string>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<string>,
      NdjsonError | Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    NdjsonError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<string>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<string>,
      NdjsonError | Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
      readonly ignoreEmptyLines?: boolean | undefined
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    NdjsonError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = dual(2, <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<string>,
    OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<string>,
    NdjsonError | Schema.SchemaError | InErr,
    InDone,
    R
  >,
  options: {
    readonly inputSchema: In
    readonly outputSchema: Out
    readonly ignoreEmptyLines?: boolean | undefined
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Out["Type"]>,
  NdjsonError | Schema.SchemaError | OutErr,
  OutDone,
  Arr.NonEmptyReadonlyArray<In["Type"]>,
  InErr,
  InDone,
  R | In["EncodingServices"] | Out["DecodingServices"]
> => ChannelSchema.duplexUnknown(duplexString(self, options), options))
