import { createMapleD1Client, type CloudflareD1Database } from "@maple/db/client"
import { Effect, Layer } from "effect"
import {
  Database,
  type DatabaseClient,
  type DatabaseShape,
  toDatabaseError,
} from "./DatabaseLive"
import { WorkerEnvironment } from "./WorkerEnvironment"

const makeD1Database = Effect.gen(function* () {
  const env = yield* WorkerEnvironment

  const binding = env.MAPLE_DB as CloudflareD1Database | undefined
  if (!binding) {
    return yield* Effect.die(new Error("Missing worker D1 binding: MAPLE_DB"))
  }

  const client = createMapleD1Client(binding) as unknown as DatabaseClient

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
