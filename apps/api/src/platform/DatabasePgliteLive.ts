import { PGlite } from "@electric-sql/pglite"
import { createMaplePgliteClient } from "@maple/db/pglite"
import { Database, type DatabaseClient, type DatabaseApi, executeWithSpan } from "./DatabaseLive"

/** `db.namespace` for the embedded Postgres used by vitest / local entrypoints. */
export const PGLITE_DB_NAMESPACE = "pglite"

/**
 * Wrap an already-migrated PGlite instance as the Database service (no
 * migration). The test harness pre-migrates via a cached SQL exec and uses
 * this directly.
 *
 * The drizzle wrapper is created per `execute` call so each call's `onQuery`
 * statement collector is isolated — a shared client + collector would
 * misattribute statements between concurrent executes. The per-call wrapper
 * only re-derives drizzle's relational config (PGlite still serializes the
 * actual queries), and this layer is vitest/local-only.
 */
export const databaseFromInstance = (pglite: PGlite): DatabaseApi =>
	Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan(
				(hooks) =>
					fn(
						// SAFETY: this test-only PGlite client implements the query surface used through DatabaseClient.
						createMaplePgliteClient(pglite, {
							onQuery: hooks.collect,
						}) as unknown as DatabaseClient,
					),
				// Without a namespace these spans collapse into the per-system
				// generic node. There is no server to address — PGlite is in-process —
				// so name the engine rather than a host, which also keeps local and
				// deployed traffic on visibly distinct nodes.
				{ "db.namespace": PGLITE_DB_NAMESPACE },
			),
	} satisfies DatabaseApi)
