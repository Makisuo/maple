import { TinybirdDateTime, QueryEngineExecuteRequest } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

export const TinybirdDateTimeString = TinybirdDateTime

export class TinybirdDecodeError extends Schema.TaggedErrorClass<TinybirdDecodeError>()(
  "TinybirdDecodeError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class TinybirdQueryError extends Schema.TaggedErrorClass<TinybirdQueryError>()(
  "TinybirdQueryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class TinybirdTransformError extends Schema.TaggedErrorClass<TinybirdTransformError>()(
  "TinybirdTransformError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class TinybirdInvalidInputError extends Schema.TaggedErrorClass<TinybirdInvalidInputError>()(
  "TinybirdInvalidInputError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type TinybirdApiError =
  | TinybirdDecodeError
  | TinybirdQueryError
  | TinybirdTransformError
  | TinybirdInvalidInputError

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function decodeInput<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
  operation: string,
): Effect.Effect<S["Type"], TinybirdDecodeError> {
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new TinybirdDecodeError({
          operation,
          message: toMessage(cause, `Invalid input for ${operation}`),
          cause,
        }),
    ),
  )
}

export function runTinybirdQuery<A>(
  operation: string,
  execute: () => Effect.Effect<A, unknown, MapleApiAtomClient>,
): Effect.Effect<A, TinybirdQueryError> {
  return Effect.suspend(execute).pipe(
    Effect.withSpan(operation),
    Effect.provide(MapleApiAtomClient.layer),
    Effect.mapError(
      (cause) =>
        new TinybirdQueryError({
          operation,
          message: toMessage(cause, `Tinybird query failed for ${operation}`),
          cause,
        }),
    ),
  )
}

export function invalidTinybirdInput(
  operation: string,
  message: string,
): Effect.Effect<never, TinybirdInvalidInputError> {
  return Effect.fail(
    new TinybirdInvalidInputError({
      operation,
      message,
    }),
  )
}

const executeQueryEngineEffect = Effect.fn("QueryEngine.execute")(
  function* (payload: QueryEngineExecuteRequest) {
    const client = yield* MapleApiAtomClient
    return yield* client.queryEngine.execute({ payload })
  },
)

export function executeQueryEngine(operation: string, payload: QueryEngineExecuteRequest) {
  return executeQueryEngineEffect(payload).pipe(
    Effect.provide(MapleApiAtomClient.layer),
    Effect.mapError(
      (cause) =>
        new TinybirdQueryError({
          operation,
          message: toMessage(cause, "Query engine request failed"),
          cause,
        }),
    ),
  )
}
