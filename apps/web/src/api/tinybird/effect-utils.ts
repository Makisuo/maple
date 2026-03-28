import { TinybirdDateTime } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

export const TinybirdDateTimeString = TinybirdDateTime

export class TinybirdApiError extends Schema.TaggedErrorClass<TinybirdApiError>()(
  "TinybirdApiError",
  {
    operation: Schema.String,
    stage: Schema.Literals(["decode", "query", "transform", "invalid"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function decodeInput<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
  operation: string,
): Effect.Effect<S["Type"], TinybirdApiError> {
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
  return Effect.suspend(execute).pipe(
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
