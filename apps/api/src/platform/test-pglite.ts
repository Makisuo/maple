import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { Effect, Layer } from "effect"
import { snapshotPath } from "../../test/pglite-snapshot"
import { Database } from "./DatabaseLive"
import { databaseFromInstance } from "./DatabasePgliteLive"

// The post-migration data directory, read once per worker process and shared by
// every instance it creates. The vitest globalSetup guarantees it exists before
// any worker starts; a missing file means this module was loaded outside the
// suite's own config, which is a wiring bug rather than something to paper over.
const SNAPSHOT = new Blob([readFileSync(snapshotPath)])

/**
 * Per-test embedded Postgres. Each call creates a fresh in-memory PGlite
 * instance restored from the pre-migrated snapshot, so the schema is already
 * there and no migration runs per test — see test/pglite-snapshot.ts for why
 * (initdb inside WASM, not the migration, was 85% of the 429ms boot). The same
 * instance backs the raw-SQL helpers below — PGlite is single-connection, so
 * there is no second connection to the DB.
 */
export interface TestDb {
	readonly pglite: PGlite
	readonly layer: Layer.Layer<Database>
	readonly close: () => Promise<void>
}

export const createTestDb = (track?: TestDb[]): TestDb => {
	const pglite = new PGlite({ loadDataDir: SNAPSHOT })
	// Building the layer twice over the same DB is legitimate (tests that provide
	// makeLayer twice to simulate concurrent service instances). Restoring the
	// snapshot is the constructor's job and happens once, so both builds just wait
	// on the same readiness promise — there is no longer a non-idempotent `exec`
	// to memoize around.
	const layer = Layer.effect(
		Database,
		Effect.gen(function* () {
			yield* Effect.promise(() => pglite.waitReady)
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
