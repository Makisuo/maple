import { createMapleLibsqlClient } from "@maple/db/client"
import { ensureMapleDbDirectory, resolveMapleDbConfig } from "@maple/db/config"
import { runMigrations } from "@maple/db/migrate"
import { Effect, Layer, Option, Redacted } from "effect"
import {
  Database,
  type DatabaseClient,
  type DatabaseShape,
  toDatabaseError,
} from "./DatabaseLive"
import { Env } from "./Env"

const makeLibsqlDatabase = Effect.gen(function* () {
  const env = yield* Env

  const dbConfig = ensureMapleDbDirectory(
    resolveMapleDbConfig({
      MAPLE_DB_URL: env.MAPLE_DB_URL,
      MAPLE_DB_AUTH_TOKEN: Option.match(env.MAPLE_DB_AUTH_TOKEN, {
        onNone: () => undefined,
        onSome: Redacted.value,
      }),
    }),
  )

  yield* Effect.tryPromise({
    try: () => runMigrations(dbConfig),
    catch: toDatabaseError,
  }).pipe(
    Effect.tap(() => Effect.logInfo("[Database] Migrations complete")),
    Effect.orDie,
  )

  const client = createMapleLibsqlClient({
    url: dbConfig.url,
    authToken: dbConfig.authToken,
  })

  return {
    client,
    execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: toDatabaseError,
      }),
  } satisfies DatabaseShape
})

export const DatabaseLibsqlLive = Layer.effect(Database, makeLibsqlDatabase)
