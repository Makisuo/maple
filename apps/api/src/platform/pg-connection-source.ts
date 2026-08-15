/**
 * Pure resolver shared by request and Workflow paths. Keep Workers on
 * Hyperdrive: request-scoped sockets make direct PSBouncer connections pay a
 * handshake per execute (measured 679ms + 158ms versus Hyperdrive's 11ms + 14ms).
 */

export const HYPERDRIVE_BINDING = "MAPLE_DB"

export type DbConnectionSource =
	| {
			readonly _tag: "Available"
			readonly connectionString: string
			/** Never contains credentials. */
			readonly attributes: Record<string, unknown>
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

export const resolveDbConnectionSource = (env: Record<string, unknown>): DbConnectionSource => {
	const binding = env[HYPERDRIVE_BINDING]
	if (!isHyperdriveBinding(binding)) {
		// PR previews intentionally omit this binding.
		return {
			_tag: "Unavailable",
			reason: `No application database on this stage (${HYPERDRIVE_BINDING} binding absent)`,
		}
	}

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
