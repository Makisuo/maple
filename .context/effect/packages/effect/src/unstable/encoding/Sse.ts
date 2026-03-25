/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Channel from "../../Channel.ts"
import * as ChannelSchema from "../../ChannelSchema.ts"
import * as Data from "../../Data.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Pull from "../../Pull.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as Transformation from "../../SchemaTransformation.ts"

/**
 * @since 4.0.0
 * @category Decoding
 */
export const decode = <IE, Done>(): Channel.Channel<
  NonEmptyReadonlyArray<Event>,
  IE | Retry,
  Done,
  NonEmptyReadonlyArray<string>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      let buffer: Array<Event> = []
      let retry: Retry | undefined
      const parser = makeParser((event) => {
        if (event._tag === "Retry") {
          retry = event
        } else {
          buffer.push(event)
        }
      })

      const pump = Effect.flatMap(upstream, (arr) => {
        for (let i = 0; i < arr.length; i++) {
          parser.feed(arr[i])
        }
        return Effect.void
      })

      return Effect.suspend(function loop(): Pull.Pull<NonEmptyReadonlyArray<Event>, IE | Retry, Done> {
        if (Arr.isArrayNonEmpty(buffer)) {
          const out = buffer
          buffer = []
          return Effect.succeed(out)
        } else if (retry) {
          return Effect.fail(retry)
        }
        return Effect.flatMap(pump, loop)
      })
    })
  )

/**
 * @since 4.0.0
 * @category Decoding
 */
export const decodeSchema = <
  Type extends {
    readonly id?: string | undefined
    readonly event: string
    readonly data: string
  },
  DecodingServices,
  IE,
  Done
>(
  schema: Schema.Decoder<Type, DecodingServices>
): Channel.Channel<
  NonEmptyReadonlyArray<Type>,
  IE | Retry | Schema.SchemaError,
  Done,
  NonEmptyReadonlyArray<string>,
  IE,
  Done,
  DecodingServices
> =>
  Channel.pipeTo(
    decode<IE, Done>(),
    ChannelSchema.decode(EventEncoded.pipe(
      Schema.decodeTo(schema)
    ))()
  )

/**
 * @since 4.0.0
 * @category Decoding
 */
export const decodeDataSchema = <Type, DecodingServices, IE, Done>(
  schema: Schema.Decoder<Type, DecodingServices>
): Channel.Channel<
  NonEmptyReadonlyArray<{
    readonly event: string
    readonly id: string | undefined
    readonly data: Type
  }>,
  IE | Retry | Schema.SchemaError,
  Done,
  NonEmptyReadonlyArray<string>,
  IE,
  Done,
  DecodingServices
> => {
  const eventSchema = Schema.Struct({
    ...EventEncoded.fields,
    data: Schema.fromJsonString(schema)
  })
  return Channel.pipeTo(
    decode<IE, Done>(),
    ChannelSchema.decode(eventSchema)()
  )
}

/**
 * Create a SSE parser.
 *
 * Adapted from https://github.com/rexxars/eventsource-parser under MIT license.
 *
 * @since 4.0.0
 * @category Decoding
 */
export function makeParser(onParse: (event: AnyEvent) => void): Parser {
  // Processing state
  let isFirstChunk: boolean
  let buffer: string
  let startingPosition: number
  let startingFieldLength: number

  // Event state
  let eventId: string | undefined
  let lastEventId: string | undefined
  let eventName: string | undefined
  let data: string

  reset()
  return { feed, reset }

  function reset(): void {
    isFirstChunk = true
    buffer = ""
    startingPosition = 0
    startingFieldLength = -1

    eventId = undefined
    eventName = undefined
    data = ""
  }

  function feed(chunk: string): void {
    buffer = buffer ? buffer + chunk : chunk

    // Strip any UTF8 byte order mark (BOM) at the start of the stream.
    // Note that we do not strip any non - UTF8 BOM, as eventsource streams are
    // always decoded as UTF8 as per the specification.
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length)
    }

    isFirstChunk = false

    // Set up chunk-specific processing state
    const length = buffer.length
    let position = 0
    let discardTrailingNewline = false

    // Read the current buffer byte by byte
    while (position < length) {
      // EventSource allows for carriage return + line feed, which means we
      // need to ignore a linefeed character if the previous character was a
      // carriage return
      // @todo refactor to reduce nesting, consider checking previous byte?
      // @todo but consider multiple chunks etc
      if (discardTrailingNewline) {
        if (buffer[position] === "\n") {
          ++position
        }
        discardTrailingNewline = false
      }

      let lineLength = -1
      let fieldLength = startingFieldLength
      let character: string

      for (let index = startingPosition; lineLength < 0 && index < length; ++index) {
        character = buffer[index]
        if (character === ":" && fieldLength < 0) {
          fieldLength = index - position
        } else if (character === "\r") {
          discardTrailingNewline = true
          lineLength = index - position
        } else if (character === "\n") {
          lineLength = index - position
        }
      }

      if (lineLength < 0) {
        startingPosition = length - position
        startingFieldLength = fieldLength
        break
      } else {
        startingPosition = 0
        startingFieldLength = -1
      }

      parseEventStreamLine(buffer, position, fieldLength, lineLength)

      position += lineLength + 1
    }

    if (position === length) {
      // If we consumed the entire buffer to read the event, reset the buffer
      buffer = ""
    } else if (position > 0) {
      // If there are bytes left to process, set the buffer to the unprocessed
      // portion of the buffer only
      buffer = buffer.slice(position)
    }
  }

  function parseEventStreamLine(
    lineBuffer: string,
    index: number,
    fieldLength: number,
    lineLength: number
  ) {
    if (lineLength === 0) {
      // We reached the last line of this event
      if (data.length > 0) {
        onParse({
          _tag: "Event",
          id: eventId,
          event: eventName ?? "message",
          data: data.slice(0, -1) // remove trailing newline
        })
        data = ""
        eventId = undefined
      }
      eventName = undefined
      return
    }

    const noValue = fieldLength < 0
    const field = lineBuffer.slice(index, index + (noValue ? lineLength : fieldLength))
    let step = 0

    if (noValue) {
      step = lineLength
    } else if (lineBuffer[index + fieldLength + 1] === " ") {
      step = fieldLength + 2
    } else {
      step = fieldLength + 1
    }

    const position = index + step
    const valueLength = lineLength - step
    const value = lineBuffer.slice(position, position + valueLength).toString()

    if (field === "data") {
      data += value ? `${value}\n` : "\n"
    } else if (field === "event") {
      eventName = value
    } else if (field === "id" && !value.includes("\u0000")) {
      eventId = value
      lastEventId = value
    } else if (field === "retry") {
      const retry = parseInt(value, 10)
      if (!Number.isNaN(retry)) {
        onParse(new Retry({ duration: Duration.millis(retry), lastEventId }))
      }
    }
  }
}

const BOM = [239, 187, 191]

function hasBom(buffer: string) {
  return BOM.every((charCode: number, index: number) => buffer.charCodeAt(index) === charCode)
}

/**
 * @since 4.0.0
 * @category Decoding
 */
export interface Parser {
  feed(chunk: string): void
  reset(): void
}

/**
 * @since 4.0.0
 * @category Encoding
 */
export const encode = <IE, Done>(): Channel.Channel<
  NonEmptyReadonlyArray<string>,
  IE,
  void,
  NonEmptyReadonlyArray<Event>,
  IE | Retry,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      let done = false
      const pull = upstream.pipe(
        Effect.map(Arr.map(encoder.write)),
        Effect.catchFilter(Retry.filter as any, (retry: any) => {
          done = true
          return Effect.succeed(Arr.of(encoder.write(retry)))
        }),
        Pull.catchDone(() => Cause.done())
      ) as Pull.Pull<Arr.NonEmptyReadonlyArray<string>, IE>
      return Effect.suspend(() => done ? Cause.done() : pull)
    })
  )

/**
 * @since 4.0.0
 * @category Encoding
 */
export const encodeSchema = <
  S extends Schema.Encoder<
    { readonly id?: string | undefined; readonly event: string; readonly data: string },
    unknown
  >,
  IE,
  Done
>(schema: S): Channel.Channel<
  NonEmptyReadonlyArray<string>,
  IE | Schema.SchemaError,
  void,
  NonEmptyReadonlyArray<S["Type"]>,
  IE | Retry,
  Done,
  S["EncodingServices"]
> =>
  ChannelSchema.encode(Event.pipe(
    Schema.decodeTo(schema, transformEvent)
  ))<IE | Retry, Done>().pipe(
    Channel.pipeTo(encode())
  )

/**
 * @since 4.0.0
 * @category Encoding
 */
export interface Encoder {
  write(event: AnyEvent): string
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface Event {
  readonly _tag: "Event"
  readonly event: string
  readonly id: string | undefined
  readonly data: string
}

/**
 * @since 4.0.0
 * @category Models
 */
export const EventEncoded: Schema.Struct<{
  readonly id: Schema.UndefinedOr<Schema.String>
  readonly event: Schema.String
  readonly data: Schema.String
}> = Schema.Struct({
  id: Schema.UndefinedOr(Schema.String),
  event: Schema.String,
  data: Schema.String
})

/**
 * @since 4.0.0
 * @category Models
 */
export const Event: Schema.Struct<{
  readonly _tag: Schema.tag<"Event">
  readonly id: Schema.UndefinedOr<Schema.String>
  readonly event: Schema.String
  readonly data: Schema.String
}> = Schema.Struct({
  _tag: Schema.tag("Event"),
  id: Schema.UndefinedOr(Schema.String),
  event: Schema.String,
  data: Schema.String
})

/**
 * @since 4.0.0
 * @category Models
 */
export const transformEvent = Transformation.transform<{
  readonly id?: string | undefined
  readonly event: string
  readonly data: string
}, {
  readonly _tag: "Event"
  readonly id: string | undefined
  readonly event: string
  readonly data: string
}>({
  decode: (event) => event,
  encode: (event) => ({
    _tag: "Event",
    id: event.id,
    event: event.event,
    data: event.data
  })
})

/**
 * @since 4.0.0
 * @category Models
 */
export interface EventEncoded {
  readonly event: string
  readonly id: string | undefined
  readonly data: string
}

const RetryTypeId = "~effect/encoding/Sse/Retry" as const

/**
 * @since 4.0.0
 * @category Models
 */
export class Retry extends Data.TaggedClass("Retry")<{
  readonly duration: Duration.Duration
  readonly lastEventId: string | undefined
}> {
  /**
   * @since 4.0.0
   */
  readonly [RetryTypeId]: typeof RetryTypeId = RetryTypeId
  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is Retry {
    return hasProperty(u, RetryTypeId)
  }
  /**
   * @since 4.0.0
   */
  static filter<A>(u: A): Result.Result<Retry, Exclude<A, Retry>> {
    return Retry.is(u) ? Result.succeed(u) : Result.fail(u as any)
  }
}

/**
 * @since 4.0.0
 * @category Models
 */
export type AnyEvent = Event | Retry

/**
 * @since 4.0.0
 * @category Encoding
 */
export const encoder: Encoder = {
  write(event: AnyEvent): string {
    switch (event._tag) {
      case "Event": {
        let data = ""
        if (event.id !== undefined) {
          data += `id: ${event.id}\n`
        }
        if (event.event !== "message") {
          data += `event: ${event.event}\n`
        }
        if (event.data !== "") {
          data += `data: ${event.data.replace(/\n/g, "\ndata: ")}\n`
        }
        return data + "\n"
      }
      case "Retry": {
        return `retry: ${Duration.toMillis(event.duration)}\n\n`
      }
    }
  }
}
