// Hyperdrive runtime binding, mirroring the token/bind shape of the old
// `Hyperdrive("MAPLE_DB")` is a lightweight token
// identifying the env binding name, and `Hyperdrive.bind(token)` returns a
// client whose `connectionString` resolves the pooled Postgres URL from the
// worker environment. Drivers (postgres.js via drizzle) dial that URL.
import type * as runtime from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import { WorkerEnvironment } from "./worker-environment.ts"

export interface HyperdriveToken {
	readonly Type: "Cloudflare.Hyperdrive"
	readonly LogicalId: string
}

const makeToken = (logicalId: string): HyperdriveToken => ({
	Type: "Cloudflare.Hyperdrive",
	LogicalId: logicalId,
})

export interface HyperdriveConnectionClient {
	/**
	 * Resolves to the raw `Hyperdrive` binding (connectionString plus the
	 * decomposed host/port/user/password/database fields).
	 */
	raw: Effect.Effect<runtime.Hyperdrive, never, WorkerEnvironment>
	/**
	 * The pooled Postgres connection string to hand to a driver. In
	 * `wrangler dev` this is the `localConnectionString` origin instead.
	 */
	connectionString: Effect.Effect<string, never, WorkerEnvironment>
}

const makeClient = (token: HyperdriveToken): HyperdriveConnectionClient => {
	const binding = WorkerEnvironment.pipe(
		Effect.map((e) => (e as Record<string, runtime.Hyperdrive>)[token.LogicalId]),
	)

	return {
		raw: binding,
		connectionString: binding.pipe(Effect.map((b) => b.connectionString)),
	}
}

/**
 * Declare a Hyperdrive binding by env binding name.
 *
 * ```ts
 * const MAPLE_DB = Hyperdrive("MAPLE_DB")
 *
 * // Then in worker handler:
 * const conn = yield* Hyperdrive.bind(MAPLE_DB)
 * const url = yield* conn.connectionString
 * ```
 */
export const Hyperdrive = Object.assign((logicalId: string): HyperdriveToken => makeToken(logicalId), {
	bind: (token: HyperdriveToken): Effect.Effect<HyperdriveConnectionClient, never, never> =>
		Effect.succeed(makeClient(token)),
})
