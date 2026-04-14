import type { MapleD1Client, MapleLibsqlClient } from "@maple/db/client"
import { Context, Effect, Schema } from "effect"

export type DatabaseClient = MapleLibsqlClient
export type DatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0]

export type AnyDatabaseClient = MapleLibsqlClient | MapleD1Client

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export interface DatabaseShape {
  readonly client: DatabaseClient
  readonly execute: <T>(
    fn: (db: DatabaseClient) => Promise<T>,
  ) => Effect.Effect<T, DatabaseError>
}

export const toDatabaseError = (cause: unknown): DatabaseError => {
  const message = cause instanceof Error ? cause.message : "Database operation failed"
  const rootCause =
    cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : undefined
  return new DatabaseError({
    message: rootCause ? `${message} [caused by: ${rootCause}]` : message,
    cause,
  })
}

export class Database extends Context.Service<Database, DatabaseShape>()("Database") {}
