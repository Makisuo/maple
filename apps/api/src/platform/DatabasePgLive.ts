import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Effect, Layer } from "effect"
import { Database, type DatabaseClient, DatabaseError, type DatabaseShape } from "./DatabaseLive"
import { executeOnFreshPgClient, PgConnectionScope } from "./pg-connection-scope"
import { resolveDbConnectionSource } from "./pg-connection-source"

// Worker TCP sockets are request-bound, so this layer holds only the connection
// string and defers the dial to whoever owns the invocation: `PgConnectionScope`
// on the request and cron paths (one socket, reused by every execute), else a
// dial per execute. Read env directly to keep this layer on WorkerEnvironment
// rather than process.env.
const makePgDatabase = Effect.gen(function* () {
	const env = yield* WorkerEnvironment
	const source = resolveDbConnectionSource(env)

	if (source._tag === "Unavailable") {
		// Fail per execute so an absent DB does not abort the isolate layer graph.
		return Database.of({
			execute: () => Effect.fail(new DatabaseError({ message: source.reason, cause: undefined })),
		} satisfies DatabaseShape)
	}

	return Database.of({
		execute: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			Effect.flatMap(PgConnectionScope, (scope) =>
				scope === undefined
					? executeOnFreshPgClient(source.connectionString, fn, source.attributes)
					: scope.run(fn),
			),
	} satisfies DatabaseShape)
})

export const layerPg = Layer.effect(Database, makePgDatabase)
