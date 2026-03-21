import { createClient } from "@libsql/client"
import { ensureMapleDbDirectory, resolveMapleDbConfig, runMigrations } from "@maple/db"
import * as schema from "@maple/db/schema"
import { drizzle } from "drizzle-orm/libsql"
import { Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import { Env } from "./Env"

const makeClient = (config: { url: string; authToken?: string }) =>
  drizzle(createClient(config), { schema })

export type DatabaseClient = ReturnType<typeof makeClient>

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export interface DatabaseShape {
  readonly client: DatabaseClient
  readonly execute: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
}

const toDatabaseError = (cause: unknown) =>
  new DatabaseError({
    message: cause instanceof Error ? cause.message : "Database operation failed",
    cause,
  })

const makeDatabase = Effect.gen(function* () {
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

  const client = makeClient({
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

export class Database extends ServiceMap.Service<Database, DatabaseShape>()("Database") {
  static readonly layer = Layer.effect(this, makeDatabase)
  static readonly Live = this.layer
  static readonly Default = this.layer
}

export const DatabaseLive = Database.layer
