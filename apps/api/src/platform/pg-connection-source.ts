/**
 * Pure resolver shared by request and Workflow paths. Keep Workers on
 * Hyperdrive: request-scoped sockets make direct PSBouncer connections pay a
 * handshake per execute (measured 679ms + 158ms versus Hyperdrive's 11ms + 14ms).
 *
 * celld has no Hyperdrive binding. `MAPLE_PG_URL` synthesizes the same
 * `{ connectionString, host, port, database }` shape; `MAPLE_PG_WS_PROXY` is the
 * Neon-compatible WebSocket proxy `@neondatabase/serverless` uses instead of TCP.
 * A string `MAPLE_DB` is still Unavailable on purpose — that binding is an object
 * or it is absent.
 */

export const HYPERDRIVE_BINDING = "MAPLE_DB"
export const MAPLE_PG_URL_VAR = "MAPLE_PG_URL"
export const MAPLE_PG_WS_PROXY_VAR = "MAPLE_PG_WS_PROXY"

export type DbConnectionSource =
	| {
			readonly _tag: "Available"
			readonly connectionString: string
			/** Never contains credentials. */
			readonly attributes: Record<string, unknown>
			/** Host-side `scripts/pg-ws-proxy.ts` (`/v1` Neon pipe). Unset = postgres.js TCP (wrangler). */
			readonly wsProxyUrl?: string
	  }
	| { readonly _tag: "Unavailable"; readonly reason: string }

interface HyperdriveBindingContract {
	readonly connectionString: string
	readonly host: string
	readonly port: number
	readonly database: string
}

const isHyperdriveBinding = (value: unknown): value is HyperdriveBindingContract => {
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

const readNonEmptyString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

const parsePostgresUrl = (
	raw: string,
):
	| {
			readonly connectionString: string
			readonly host: string
			readonly port: number
			readonly database: string
	  }
	| undefined => {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return undefined
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return undefined
	const host = url.hostname
	if (host.length === 0) return undefined
	const port = url.port.length === 0 ? 5432 : Number(url.port)
	if (!Number.isFinite(port) || port <= 0) return undefined
	const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""))
	const database = path.split("/")[0] ?? ""
	return {
		connectionString: raw,
		host,
		port,
		database: database.length > 0 ? database : "postgres",
	}
}

const readWsProxyUrl = (value: unknown): string | undefined => {
	const raw = readNonEmptyString(value)
	if (raw === undefined) return undefined
	if (!raw.startsWith("ws://") && !raw.startsWith("wss://")) return undefined
	return raw
}

export const resolveDbConnectionSource = (env: Record<string, unknown>): DbConnectionSource => {
	const binding = env[HYPERDRIVE_BINDING]
	if (isHyperdriveBinding(binding)) {
		return {
			_tag: "Available",
			connectionString: binding.connectionString,
			attributes: {
				// The read path normalizes Hyperdrive's opaque host/database to its sentinel node.
				"db.namespace": binding.database,
				"server.address": binding.host,
				"server.port": binding.port,
			},
		}
	}

	const pgUrl = readNonEmptyString(env[MAPLE_PG_URL_VAR])
	if (pgUrl !== undefined) {
		const parsed = parsePostgresUrl(pgUrl)
		if (parsed !== undefined) {
			const wsProxyUrl = readWsProxyUrl(env[MAPLE_PG_WS_PROXY_VAR])
			return {
				_tag: "Available",
				connectionString: parsed.connectionString,
				attributes: {
					"db.namespace": parsed.database,
					"server.address": parsed.host,
					"server.port": parsed.port,
				},
				...(wsProxyUrl === undefined ? undefined : { wsProxyUrl }),
			}
		}
	}

	return {
		_tag: "Unavailable",
		reason: `No application database on this stage (${HYPERDRIVE_BINDING} binding absent)`,
	}
}
