import { readFileSync } from "node:fs"
import { PGlite, type Transaction } from "@electric-sql/pglite"
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

/**
 * Reject a bound `Date`, which PGlite accepts and the deployed driver does not.
 *
 * Production runs `drizzle-orm/postgres-js` → `client.unsafe(sql, params)`, which
 * refuses a `Date` param outright ("Received an instance of Date"). PGlite
 * serializes one happily, so without this the difference is invisible to the
 * suite — which is how a raw `sql` template binding a `Date` reached production
 * and stalled the error tick for 25 hours.
 *
 * There is no legitimate `Date` param: every timestamptz column is
 * `mode: "date"`, whose `mapToDriverValue` already returns an ISO string. A
 * `Date` surviving into the param array therefore always means a raw `sql`
 * fragment with no column type behind it — use `msToSqlTimestamp` there.
 */
const assertNoDateParams = (sql: string, params: unknown[] | undefined): void => {
	const index = params?.findIndex((param) => param instanceof Date) ?? -1
	if (index === -1) return
	throw new Error(
		`Bound a Date as param $${index + 1}, which the deployed postgres.js driver rejects. ` +
			`Interpolate an ISO string (msToSqlTimestamp) into raw \`sql\` templates instead.\n${sql}`,
	)
}

/**
 * PGlite with the guard applied to `query` and, crucially, to the client
 * drizzle hands to a `transaction` callback — that is a different object, and
 * without re-wrapping it the guard would miss every statement inside a
 * transaction, which is exactly where the raw templates live.
 */
const withDateParamGuard = <T extends object>(client: T): T =>
	new Proxy(client, {
		get(target, property) {
			// SAFETY: a Proxy get trap receives a key for its target; indexed access preserves
			// the target's own property type while the runtime branch below validates callability.
			const value = target[property as keyof T]
			if (typeof value !== "function") return value
			if (property === "query") {
				return (sql: string, params?: unknown[], ...rest: unknown[]) => {
					assertNoDateParams(sql, params)
					return value.call(target, sql, params, ...rest)
				}
			}
			if (property === "transaction") {
				return <Result>(callback: (tx: Transaction) => Promise<Result>) =>
					value.call(target, (tx: Transaction) => callback(withDateParamGuard(tx)))
			}
			return value.bind(target)
		},
	})

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
			// The raw instance stays on `TestDb.pglite` for executeSql/queryFirstRow —
			// those are test fixtures writing their own SQL, not the app's write path.
			return databaseFromInstance(withDateParamGuard(pglite))
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
