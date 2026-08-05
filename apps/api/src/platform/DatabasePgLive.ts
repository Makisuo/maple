import { Hyperdrive } from "@maple/effect-cloudflare/hyperdrive-connection"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, DatabaseError, type DatabaseShape } from "./DatabaseLive"
import { executeOnFreshPgClient } from "./pg-execute"

const MAPLE_DB = Hyperdrive("MAPLE_DB")

// Workers constraint: this layer lives for the isolate, but TCP sockets are
// tied to the request that opened them. So the layer holds only the Hyperdrive
// connection string and defers the dial to `executeOnFreshPgClient` — see
// pg-execute.ts for why that is per-call.
const makePgDatabase = Effect.gen(function* () {
	const conn = yield* Hyperdrive.bind(MAPLE_DB)
	const binding = yield* conn.raw
	if (!binding) {
		// Stages deployed without an application database (PR previews since
		// 2026-08 — see resolveDatabaseMode in packages/infra). Dying here would
		// abort construction of the ENTIRE isolate layer graph (layerPg is
		// provideMerge'd into the handler in worker.ts), 504-ing every route
		// including /health. Failing per `execute` keeps DB-free routes serving
		// and turns DB-backed ones into ordinary 500s.
		return Database.of({
			execute: () =>
				Effect.fail(
					new DatabaseError({
						message: "No application database on this stage (MAPLE_DB binding absent)",
						cause: undefined,
					}),
				),
		} satisfies DatabaseShape)
	}

	const connectionString = binding.connectionString
	// Hyperdrive presents itself to the driver as `<config-id>.hyperdrive.local`
	// with the 32-char config id as the database name. Maple's read path
	// deliberately collapses both spellings to the `hyperdrive` sentinel node
	// (see OPAQUE_DB_NAMESPACE_RE in @maple/domain/tinybird/db-query-shape-sql),
	// so emitting them as-is is correct — the node is branded "Hyperdrive" and
	// the frontend resolves the real database behind it from the org's
	// Hyperdrive config inventory.
	const databaseName = binding.database
	const serverAddress = binding.host
	const serverPort = binding.port

	return Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeOnFreshPgClient(connectionString, fn, {
				"db.namespace": databaseName,
				"server.address": serverAddress,
				"server.port": serverPort,
			}),
	} satisfies DatabaseShape)
})

export const layerPg = Layer.effect(Database, makePgDatabase)
