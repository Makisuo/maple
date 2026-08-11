import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, DatabaseError, type DatabaseShape } from "./DatabaseLive"
import { executeOnFreshPgClient } from "./pg-execute"
import { resolveDbConnectionSource } from "./pg-connection-source"

// Workers constraint: this layer lives for the isolate, but TCP sockets are
// tied to the request that opened them. So the layer holds only the connection
// string and defers the dial to `executeOnFreshPgClient` — see pg-execute.ts
// for why that is per-call.
//
// The env record is read directly rather than through `Env`/`Config` so this
// layer's only requirement stays `WorkerEnvironment`: apps/alerting wires
// `WorkerConfigProviderLayer` into `EnvLive` alone, not globally
// (apps/alerting/src/worker.ts), so a `Config` read here would fall through to
// the default provider (`process.env`, empty in a Worker) and silently resolve
// to nothing.
const makePgDatabase = Effect.gen(function* () {
	const env = yield* WorkerEnvironment
	const source = resolveDbConnectionSource(env)

	if (source._tag === "Unavailable") {
		// Dying here would abort construction of the ENTIRE isolate layer graph
		// (layerPg is provideMerge'd into the handler in worker.ts), 504-ing every
		// route including /health. Failing per `execute` keeps DB-free routes
		// serving and turns DB-backed ones into ordinary 500s.
		return Database.of({
			execute: () => Effect.fail(new DatabaseError({ message: source.reason, cause: undefined })),
		} satisfies DatabaseShape)
	}

	return Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeOnFreshPgClient(source.connectionString, fn, source.attributes),
	} satisfies DatabaseShape)
})

export const layerPg = Layer.effect(Database, makePgDatabase)
