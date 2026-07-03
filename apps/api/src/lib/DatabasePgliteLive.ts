import { PGlite } from "@electric-sql/pglite"
import { createMaplePgliteClient } from "@maple/db/client"
import { ensureMapleDbDirectory, resolveMapleDbConfig } from "@maple/db/config"
import { runMigrations } from "@maple/db/migrate"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, executeWithSpan, toDatabaseError } from "./DatabaseLive"
import { Env } from "./Env"

/**
 * Wrap an already-migrated PGlite instance as the Database service (no
 * migration). The test harness pre-migrates via a cached SQL exec and uses
 * this directly; `makeFromInstance` runs the canonical drizzle migrator first.
 *
 * The drizzle wrapper is created per `execute` call so each call's `onQuery`
 * statement collector is isolated — a shared client + collector would
 * misattribute statements between concurrent executes. The per-call wrapper
 * only re-derives drizzle's relational config (PGlite still serializes the
 * actual queries), and this layer is vitest/local-only.
 */
export const databaseFromInstance = (pglite: PGlite): DatabaseShape =>
	Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan((collect) =>
				fn(createMaplePgliteClient(pglite, { onQuery: collect }) as unknown as DatabaseClient),
			),
	} satisfies DatabaseShape)

const makeFromInstance = (pglite: PGlite) =>
	Effect.gen(function* () {
		yield* Effect.tryPromise({
			try: () => runMigrations(pglite),
			catch: toDatabaseError,
		}).pipe(
			Effect.tap(() => Effect.logInfo("[Database] Migrations complete")),
			Effect.orDie,
		)

		return databaseFromInstance(pglite)
	})

/**
 * Embedded-Postgres Database layer for everything that is not a deployed
 * Worker: vitest, MCP evals, and local non-wrangler entrypoints. Resolves the
 * PGlite data dir from MAPLE_DB_URL (`memory://` for ephemeral instances —
 * each layer build gets a fresh database — or a directory for persistence)
 * and applies the bundled drizzle migrations on startup.
 */
const makePgliteDatabase = Effect.gen(function* () {
	const env = yield* Env

	const dbConfig = ensureMapleDbDirectory(resolveMapleDbConfig({ MAPLE_DB_URL: env.MAPLE_DB_URL }))

	const pglite = yield* Effect.tryPromise({
		try: () => PGlite.create(dbConfig.dataDir),
		catch: toDatabaseError,
	}).pipe(Effect.orDie)

	return yield* makeFromInstance(pglite)
})

export const DatabasePgliteLive = Layer.effect(Database, makePgliteDatabase)
