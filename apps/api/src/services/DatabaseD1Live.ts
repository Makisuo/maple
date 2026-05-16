import { createMapleD1Client, type CloudflareD1Database } from "@maple/db/client"
import { reshapeDashboardWidgets } from "@maple/db/migrate"
import { D1Database as D1DatabaseToken } from "@maple/effect-cloudflare/d1-connection"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, toDatabaseError } from "./DatabaseLive"

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

	// The D1 worker never calls runMigrations; the data migration is guarded by
	// the _maple_data_migrations table, so every later boot is a single SELECT.
	yield* Effect.tryPromise({
		try: () => reshapeDashboardWidgets(client),
		catch: toDatabaseError,
	}).pipe(
		Effect.tap(() => Effect.logInfo("[Database] Dashboard data migration complete")),
		Effect.orDie,
	)

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
