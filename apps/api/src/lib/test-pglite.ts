import { PGlite } from "@electric-sql/pglite"
import { readBundledMigrationsSql } from "@maple/db/migrate"
import { Effect, Layer } from "effect"
import { Database } from "./DatabaseLive"
import { databaseFromInstance } from "./DatabasePgliteLive"

// Read + concatenate the bundled migration SQL once for the whole test process.
const MIGRATIONS_SQL = readBundledMigrationsSql()

/**
 * Per-test embedded Postgres. Each call creates a fresh in-memory PGlite
 * instance; `layer` applies the bundled schema with a single `pglite.exec()`
 * (the SQL is read once at module load, not per test — avoids the drizzle
 * migrator's per-instance filesystem reads, which starve under CI's parallel
 * `turbo test`). The same instance backs the raw-SQL helpers below — PGlite is
 * single-connection, so there is no second connection to the DB.
 */
export interface TestDb {
	readonly pglite: PGlite
	readonly layer: Layer.Layer<Database>
	readonly close: () => Promise<void>
}

export const createTestDb = (track?: TestDb[]): TestDb => {
	const pglite = new PGlite()
	// Migrate exactly once per instance, even when the layer is built multiple
	// times over the same DB (e.g. tests that provide makeLayer twice to
	// simulate concurrent service instances). The raw `exec` of the baseline SQL
	// is not idempotent — a second `CREATE TABLE` would error — so memoize the
	// promise (drizzle's migrator used to dedupe this via __drizzle_migrations).
	let migrated: Promise<unknown> | undefined
	const layer = Layer.effect(
		Database,
		Effect.gen(function* () {
			yield* Effect.promise(() => (migrated ??= pglite.exec(MIGRATIONS_SQL)))
			return databaseFromInstance(pglite)
		}),
	)
	const db: TestDb = {
		pglite,
		layer,
		close: () => pglite.close(),
	}
	track?.push(db)
	return db
}

export const cleanupTestDbs = async (dbs: TestDb[]): Promise<void> => {
	for (const db of dbs.splice(0, dbs.length)) {
		await db.close().catch(() => {})
	}
}

/** Raw SQL against the test instance. Placeholders are Postgres-style ($1, $2, …). */
export const executeSql = async (db: TestDb, sql: string, params: unknown[] = []): Promise<void> => {
	await db.pglite.query(sql, params)
}

export const queryFirstRow = async <T>(
	db: TestDb,
	sql: string,
	params: unknown[] = [],
): Promise<T | undefined> => {
	const result = await db.pglite.query<T>(sql, params)
	return result.rows[0]
}
