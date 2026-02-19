import { TinybirdDateTime } from "@maple/domain"
import { Effect, Schema } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

export const TinybirdDateTimeString = TinybirdDateTime

export class TinybirdApiError extends Schema.TaggedError<TinybirdApiError>()(
  "TinybirdApiError",
  {
    operation: Schema.String,
    stage: Schema.Literal("decode", "query", "transform", "invalid"),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function decodeInput<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  operation: string,
): Effect.Effect<A, TinybirdApiError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new TinybirdApiError({
        operation,
        stage: "decode",
        message: toMessage(cause, `Invalid input for ${operation}`),
        cause,
      }),
  })
}

export function runTinybirdQuery<A>(
  operation: string,
  execute: () => Effect.Effect<A, unknown, MapleApiAtomClient>,
): Effect.Effect<A, TinybirdApiError> {
  return Effect.try({
    try: execute,
    catch: (cause) =>
      new TinybirdApiError({
        operation,
        stage: "query",
        message: toMessage(cause, `Tinybird query failed for ${operation}`),
        cause,
      }),
  }).pipe(
    Effect.flatMap((effect) => effect),
    Effect.provide(MapleApiAtomClient.layer),
    Effect.mapError(
      (cause) =>
        cause instanceof TinybirdApiError
          ? cause
          : new TinybirdApiError({
              operation,
              stage: "query",
              message: toMessage(cause, `Tinybird query failed for ${operation}`),
              cause,
            }),
    ),
  )
}

export function invalidTinybirdInput(
  operation: string,
  message: string,
): Effect.Effect<never, TinybirdApiError> {
  return Effect.fail(
    new TinybirdApiError({
      operation,
      stage: "invalid",
      message,
    }),
  )
}
