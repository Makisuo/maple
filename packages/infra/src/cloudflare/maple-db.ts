import type * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { Connection } from "alchemy/Cloudflare/Hyperdrive"
import { requiredPlain } from "../env.ts"
import { MapleStack } from "./stack.ts"
import {
	type MapleDbConsumer,
	type MapleStage,
	resolveDatabaseMode,
	resolveHyperdriveName,
	resolveHyperdriveRefId,
} from "./stage.ts"

/**
 * The application database as `MAPLE_DB`, in the shape `resolveDatabaseMode`
 * picks for the stage:
 *
 * - `"managed"` (dev stages): the alchemy-managed Hyperdrive below, origin
 *   parsed from `MAPLE_PG_URL` (Hyperdrive wants a structured origin). Declared
 *   here once and yielded from every Worker module that binds it — alchemy
 *   registers a resource by id, so the second yield returns the first's.
 * - `"ref"` (stg/prd): nothing to create; `bindMapleDbRef` attaches the
 *   dashboard-managed config after the Worker exists.
 * - `"none"` (PR previews): no binding at all.
 */
export const ManagedMapleDb = Effect.gen(function* () {
	const { stage } = yield* MapleStack
	if (resolveDatabaseMode(stage) !== "managed") return undefined
	const pgUrl = new URL(yield* requiredPlain("MAPLE_PG_URL"))
	return yield* Connection("maple-db", {
		name: resolveHyperdriveName(stage),
		origin: {
			scheme: "postgres",
			host: pgUrl.hostname,
			port: Number(pgUrl.port || "5432"),
			// Connect-time db (`postgres`, the PlanetScale cluster default),
			// not the PS resource name.
			database: pgUrl.pathname.replace(/^\//, "") || "postgres",
			user: decodeURIComponent(pgUrl.username),
			password: Redacted.make(decodeURIComponent(pgUrl.password)),
		},
		// Read-after-write everywhere (alert state CAS, dashboard versioning) —
		// revisit caching once read paths that tolerate staleness are identified.
		caching: { disabled: true },
		dev: {
			scheme: "postgres",
			host: "localhost",
			port: 5499,
			database: "maple",
			user: "maple",
			password: Redacted.make("maple"),
			// Alchemy defaults dev origins to `sslmode=prefer`; the docker Postgres has
			// no TLS and the dial would stall until the timeout.
			sslmode: "disable",
		},
	})
})

/**
 * stg/prd: bind the dashboard-managed Hyperdrive config by id (v1's
 * `HyperdriveRef`, which v2 lacks). The origin and credentials live only in the
 * Cloudflare dashboard, so deploys never see them and `MAPLE_PG_URL` is not
 * required. Alchemy has no `env` form for a binding it did not create — its own
 * `Hyperdrive.Connect` attaches the same raw metadata — so this runs after the
 * Worker exists. No-op on every other stage.
 */
export const bindMapleDbRef = (worker: Cloudflare.Worker, stage: MapleStage, consumer: MapleDbConsumer) => {
	const id = resolveHyperdriveRefId(stage, consumer)
	return id === undefined
		? Effect.void
		: worker.bind("MAPLE_DB", { bindings: [{ type: "hyperdrive", name: "MAPLE_DB", id }] })
}
