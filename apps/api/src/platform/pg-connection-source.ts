/**
 * Resolve the `MAPLE_DB` Hyperdrive binding to a connection string plus the
 * span attributes that identify the origin.
 *
 * Shared by the request path (`DatabasePgLive`) and both Workflow entrypoints,
 * which each used to hand-roll their own structural narrow of the binding —
 * three slightly different versions, none of them tested, two of which threw
 * where the third degraded.
 *
 * Kept deliberately pure — no Effect, no I/O — so the "is there a database on
 * this stage" decision is unit-testable without a Worker isolate.
 *
 * A direct-to-PSBouncer transport briefly lived here as an alternative to
 * Hyperdrive (2026-08-11) and was removed the same day: dialing the pooler
 * straight from a Worker costs a full handshake per `execute`, because Workers
 * tie sockets to the request that opened them. Measured against prod, that was
 * 679ms connect + 158ms query versus Hyperdrive's 11ms + 14ms — same region,
 * same endpoint `apps/ingest` uses happily from a long-lived pool. Holding the
 * connection pool is the thing Hyperdrive is actually for here, so if the
 * question comes up again the answer is not "bypass Hyperdrive" but "stop
 * dialing per execute", which Workers do not currently allow.
 */

/** Env binding holding the Hyperdrive connection. */
export const HYPERDRIVE_BINDING = "MAPLE_DB"

export type DbConnectionSource =
	| {
			readonly _tag: "Available"
			readonly connectionString: string
			/** Span attributes for `executeWithSpan`'s `extraAttributes`. Never contains credentials. */
			readonly attributes: Record<string, unknown>
	  }
	| { readonly _tag: "Unavailable"; readonly reason: string }

/**
 * The subset of the Hyperdrive binding this module reads. Structural, because
 * the runtime binding is an opaque host object.
 */
interface HyperdriveBindingShape {
	readonly connectionString: string
	readonly host: string
	readonly port: number
	readonly database: string
}

const isHyperdriveBinding = (value: unknown): value is HyperdriveBindingShape => {
	if (typeof value !== "object" || value === null) return false
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.connectionString === "string" &&
		candidate.connectionString !== "" &&
		typeof candidate.host === "string" &&
		typeof candidate.port === "number" &&
		typeof candidate.database === "string"
	)
}

/**
 * Resolve the application database for this worker.
 *
 * `Unavailable` is never a throw: callers turn it into a per-`execute`
 * `DatabaseError` so DB-free routes keep serving (see `DatabasePgLive`).
 */
export const resolveDbConnectionSource = (env: Record<string, unknown>): DbConnectionSource => {
	const binding = env[HYPERDRIVE_BINDING]
	if (!isHyperdriveBinding(binding)) {
		// Stages deployed without an application database (PR previews since
		// 2026-08 — see resolveDatabaseMode in @maple/infra), and typo'd bindings.
		return {
			_tag: "Unavailable",
			reason: `No application database on this stage (${HYPERDRIVE_BINDING} binding absent)`,
		}
	}

	return {
		_tag: "Available",
		connectionString: binding.connectionString,
		attributes: {
			// Hyperdrive presents itself to the driver as
			// `<config-id>.hyperdrive.local` with the 32-char config id as the
			// database name. Maple's read path deliberately collapses both spellings
			// to the `hyperdrive` sentinel node (see OPAQUE_DB_NAMESPACE_RE in
			// @maple/domain/tinybird/db-query-shape-sql), so emitting them as-is is
			// correct — the node is branded "Hyperdrive" and the frontend resolves
			// the real database behind it from the org's Hyperdrive config inventory.
			"db.namespace": binding.database,
			"server.address": binding.host,
			"server.port": binding.port,
		},
	}
}
