import { createMaplePgClient } from "@maple/db/client"
import { Hyperdrive } from "@maple/effect-cloudflare/hyperdrive-connection"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, type DatabaseShape, executeWithSpan } from "./DatabaseLive"

const MAPLE_DB = Hyperdrive("MAPLE_DB")

// Workers constraint: this layer lives for the isolate, but TCP sockets are
// tied to the request that opened them. So the layer holds only the
// Hyperdrive connection string; every `execute` dials a fresh single-
// connection postgres.js client and closes it when the callback settles.
// Hyperdrive keeps the warm origin pool, so the per-call handshake is cheap.
// Transactions run inside one `execute` callback, so atomicity is unaffected.
const makePgDatabase = Effect.gen(function* () {
	const conn = yield* Hyperdrive.bind(MAPLE_DB)
	const binding = yield* conn.raw
	if (!binding) {
		return yield* Effect.die(new Error("Missing worker Hyperdrive binding: MAPLE_DB"))
	}

	const connectionString = binding.connectionString
	const databaseName = binding.database

	return Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan(
				async (collect) => {
					const { db, end } = createMaplePgClient(connectionString, {
						maxConnections: 1,
						onQuery: collect,
					})
					try {
						return await fn(db)
					} finally {
						// Never let a socket-teardown error shadow the real DB error
						// from fn(db) (mirrors ClickHouseSchemaApplyWorkflow.run.ts).
						await end().catch(() => undefined)
					}
				},
				{ "db.namespace": databaseName },
			),
	} satisfies DatabaseShape)
})

export const DatabasePgLive = Layer.effect(Database, makePgDatabase)
