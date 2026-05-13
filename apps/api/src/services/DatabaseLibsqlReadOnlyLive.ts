import { createMapleLibsqlClient } from "@maple/db/client"
import { ensureMapleDbDirectory, resolveMapleDbConfig } from "@maple/db/config"
import { Effect, Layer, Option, Redacted } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, toDatabaseError } from "./DatabaseLive"
import { Env } from "./Env"

/**
 * Identical to `DatabaseLibsqlLive` except it does NOT run drizzle migrations.
 *
 * Use this when the process is a CONSUMER of an already-provisioned libsql DB
 * (e.g. the chat-agent service connecting to the same DB the API worker /
 * api-libsql process owns). Running drizzle's migrator on every consumer
 * fights with the owner's migration history and produces
 * "table X already exists" errors on every fresh boot.
 */
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

export const DatabaseLibsqlReadOnlyLive = Layer.effect(Database, makeLibsqlDatabase)
