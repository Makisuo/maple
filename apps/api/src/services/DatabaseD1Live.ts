import { createMapleD1Client, type CloudflareD1Database } from "@maple/db/client"
import { Effect, Layer, Option } from "effect"
import {
  Database,
  type DatabaseClient,
  type DatabaseShape,
  toDatabaseError,
} from "./DatabaseLive"
import { WorkerBindings, getWorkerBinding } from "./WorkerBindings"

const makeD1Database = Effect.gen(function* () {
  const bindings = yield* WorkerBindings

  const binding = yield* Option.match(getWorkerBinding(bindings, "MAPLE_DB"), {
    onNone: () =>
      Effect.die(new Error("Missing worker D1 binding: MAPLE_DB")),
    onSome: Effect.succeed,
  })

  const client = createMapleD1Client(
    binding as CloudflareD1Database,
  ) as unknown as DatabaseClient

  return {
    client,
    execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: toDatabaseError,
      }),
  } satisfies DatabaseShape
})

export const DatabaseD1Live = Layer.effect(Database, makeD1Database)
