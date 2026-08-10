/**
 * Which transport reaches PlanetScale Postgres, resolved from the worker env.
 *
 * Two paths coexist so they can be compared on real telemetry before one is
 * deleted:
 *
 * - **hyperdrive** — the `MAPLE_DB` Hyperdrive binding. The historical default.
 * - **direct** — a `MAPLE_DB_DIRECT_URL` secret pointing at PlanetScale's
 *   PSBouncer pooler (port 6432), dialed straight from the Worker over
 *   `cloudflare:sockets`. Same mechanism `apps/ingest` has used in production
 *   since the Railway days.
 *
 * Why the switch exists (measured 2026-08-11, 6h window): `alerting` completed
 * 270,151 dials with **zero** failures while `maple-api` failed 239 of 5,402
 * (4.4%) — same driver, same options, same region. The one thing that differs
 * is the Hyperdrive config each binds (`maple-alerting-prd` vs `maple-prd`, see
 * `resolveHyperdriveRefId` in @maple/infra), so the fault is that config rather
 * than the client. Direct dialing bypasses it.
 *
 * Kept deliberately pure — no Effect, no I/O. Everything interesting here is a
 * decision, and a decision that can be unit-tested is one that cannot silently
 * resolve to the wrong transport while you believe you flipped it.
 */

/** Env binding holding the direct PSBouncer URL. Presence of this IS the switch. */
export const DIRECT_URL_BINDING = "MAPLE_DB_DIRECT_URL"

/** Env binding holding the Hyperdrive connection. */
export const HYPERDRIVE_BINDING = "MAPLE_DB"

export type DbConnectMode = "hyperdrive" | "direct"

export type DbConnectionSource =
	| {
			readonly _tag: "Available"
			readonly connectionString: string
			/**
			 * Span attributes for `executeWithSpan`'s `extraAttributes`. Never
			 * contains credentials — see `parseDirectUrl`.
			 */
			readonly attributes: Record<string, unknown>
	  }
	| { readonly _tag: "Unavailable"; readonly reason: string }

/**
 * The subset of the Hyperdrive binding this module reads. Structural, because
 * the runtime binding is an opaque host object and the two Workflow
 * entrypoints each hand-rolled this same narrow before it lived here.
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

/** Blank is absent, matching `optionalRedacted` in @maple/effect-cloudflare/config-helpers. */
const readNonBlankString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Parse the direct URL for its span attributes.
 *
 * Reads only host/port/database — **never** `username`/`password`, so a
 * credential cannot reach a span. `sslmode=require` is mandatory rather than
 * advisory: without it postgres.js leaves `socket.ssl` falsy
 * (`cf/src/connection.js:355`) and opens the socket without
 * `secureTransport: "starttls"` (`cf/polyfills.js:148`), so the dial fails in a
 * way that surfaces as a generic connect error. Rejecting it here turns that
 * into a message naming the fix.
 */
const parseDirectUrl = (raw: string): DbConnectionSource => {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return {
			_tag: "Unavailable",
			reason: `${DIRECT_URL_BINDING} is not a valid URL`,
		}
	}
	if (url.searchParams.get("sslmode") !== "require") {
		return {
			_tag: "Unavailable",
			reason: `${DIRECT_URL_BINDING} must include ?sslmode=require (PlanetScale rejects plaintext, and postgres.js only negotiates TLS when it is set)`,
		}
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres"
	return {
		_tag: "Available",
		connectionString: raw,
		attributes: {
			"db.connect.mode": "direct" satisfies DbConnectMode,
			"db.namespace": database,
			"server.address": url.hostname,
			// PSBouncer is 6432; fall back to the Postgres default if the URL omits it.
			"server.port": Number(url.port) || 5432,
		},
	}
}

/**
 * Resolve which Postgres transport this worker should use.
 *
 * Precedence: a present `MAPLE_DB_DIRECT_URL` wins, and a *malformed* one
 * fails rather than falling back. Silent fallback would make the comparison
 * undecidable — you would be reading spans labelled `direct` that were actually
 * Hyperdrive, which defeats the purpose of having the attribute.
 *
 * `Unavailable` is never a throw: callers turn it into a per-`execute`
 * `DatabaseError` so DB-free routes keep serving (see `DatabasePgLive`).
 */
export const resolveDbConnectionSource = (env: Record<string, unknown>): DbConnectionSource => {
	const directUrl = readNonBlankString(env[DIRECT_URL_BINDING])
	if (directUrl !== undefined) {
		return parseDirectUrl(directUrl)
	}

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
			"db.connect.mode": "hyperdrive" satisfies DbConnectMode,
			// Hyperdrive presents itself to the driver as
			// `<config-id>.hyperdrive.local` with the 32-char config id as the
			// database name. Maple's read path deliberately collapses both spellings
			// to the `hyperdrive` sentinel node (see OPAQUE_DB_NAMESPACE_RE in
			// @maple/domain/tinybird/db-query-shape-sql), so emitting them as-is is
			// correct — the node is branded "Hyperdrive" and the frontend resolves
			// the real database behind it from the org's Hyperdrive config inventory.
			//
			// The direct branch above emits the REAL database name, which does not
			// match that regex. So while both modes are live the service map shows
			// two database nodes for one origin. That is expected, and it is free
			// confirmation that traffic actually moved.
			"db.namespace": binding.database,
			"server.address": binding.host,
			"server.port": binding.port,
		},
	}
}
