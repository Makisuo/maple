// Simplified port of alchemy-effect's D1 connection binding:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/D1/D1Connection.ts
//
// The alchemy D1 binding is split across three files (`D1Database.ts` —
// resource provider, `D1Connection.ts` — runtime service, `D1DatabaseBinding.ts`
// — IaC bind-to-worker helper). For maple we only need the runtime half:
// `D1Database("MAPLE_DB")` is a lightweight token identifying the env var
// name, and `D1Database.bind(token)` returns the connection client.
//
// The `.raw` accessor on the client is important — it lets `DatabaseD1Live`
// pull out the underlying `runtime.D1Database` to hand to drizzle.
import type * as runtime from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import { WorkerEnvironment } from "./worker-environment.ts"

export interface D1DatabaseToken {
	readonly Type: "Cloudflare.D1Database"
	readonly LogicalId: string
}

const makeToken = (logicalId: string): D1DatabaseToken => ({
	Type: "Cloudflare.D1Database",
	LogicalId: logicalId,
})

export interface D1ConnectionClient {
	/**
	 * Resolves to the raw underlying Cloudflare `D1Database` binding. Use this
	 * when a driver (e.g. drizzle, better-auth) needs direct access.
	 */
	raw: Effect.Effect<runtime.D1Database, never, WorkerEnvironment>
	/**
	 * Prepare a SQL statement for parameterised execution.
	 */
	prepare: (query: string) => Effect.Effect<runtime.D1PreparedStatement, never, WorkerEnvironment>
	/**
	 * Execute raw SQL without prepared statements.
	 */
	exec: (query: string) => Effect.Effect<runtime.D1ExecResult, never, WorkerEnvironment>
	/**
	 * Batch multiple prepared statements — rolled back on failure.
	 */
	batch: <T = unknown>(
		statements: runtime.D1PreparedStatement[],
	) => Effect.Effect<runtime.D1Result<T>[], never, WorkerEnvironment>
}

const makeClient = (token: D1DatabaseToken): D1ConnectionClient => {
	const env = WorkerEnvironment.asEffect()
	const d1 = env.pipe(Effect.map((e) => (e as Record<string, runtime.D1Database>)[token.LogicalId]))

	return {
		raw: d1,
		prepare: (query: string) => d1.pipe(Effect.map((db) => db.prepare(query))),
		exec: (query: string) => d1.pipe(Effect.flatMap((db) => Effect.promise(() => db.exec(query)))),
		batch: <T = unknown>(statements: runtime.D1PreparedStatement[]) =>
			d1.pipe(Effect.flatMap((db) => Effect.promise(() => db.batch<T>(statements)))),
	}
}

/**
 * Declare a D1 database binding by env var name.
 *
 * ```ts
 * export const MAPLE_DB = D1Database("MAPLE_DB")
 *
 * // Then in worker handler:
 * const conn = yield* D1Database.bind(MAPLE_DB)
 * const stmt = yield* conn.prepare("SELECT ?").bind(1)
 * ```
 */
export const D1Database = Object.assign((logicalId: string): D1DatabaseToken => makeToken(logicalId), {
	bind: (token: D1DatabaseToken): Effect.Effect<D1ConnectionClient, never, never> =>
		Effect.succeed(makeClient(token)),
})

// Alias preserving alchemy's `D1Connection` export name. Both surface the
// same `.bind()` API so either import style works during migration.
export const D1Connection = D1Database
