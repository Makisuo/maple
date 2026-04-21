import { createMapleD1Client, type CloudflareD1Database } from "@maple/db/client"
import { D1Database as D1DatabaseToken } from "@maple/effect-cloudflare"
import { Effect, Layer } from "effect"
import {
  Database,
  type DatabaseClient,
  type DatabaseShape,
  toDatabaseError,
} from "./DatabaseLive"

const MAPLE_DB = D1DatabaseToken("MAPLE_DB")

const makeD1Database = Effect.gen(function* () {
  const conn = yield* D1DatabaseToken.bind(MAPLE_DB)
  const binding = yield* conn.raw
  if (!binding) {
    return yield* Effect.die(new Error("Missing worker D1 binding: MAPLE_DB"))
  }

  const client = createMapleD1Client(
    binding as unknown as CloudflareD1Database,
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
