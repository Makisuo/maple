/**
 * Resolves what actually sits behind the service map's collapsed Hyperdrive node:
 * the org's polled Hyperdrive config inventory is matched against the PlanetScale
 * database inventory by origin database name. Pure and unit-testable — no fetch,
 * no React.
 */

/** One Hyperdrive config from the `cloudflareHyperdrives` integrations endpoint. */
export interface HyperdriveConfigInput {
	readonly id: string
	readonly name: string
	readonly originHost: string | null
	readonly originPort: number | null
	readonly originScheme: string
	readonly originDatabase: string
	readonly originUser: string | null
}

/** A config resolved for display on the Hyperdrive node (detail panel + map edge). */
export interface HyperdriveNodeInfo {
	readonly id: string
	readonly name: string
	readonly originDatabase: string
	readonly originScheme: string
	readonly originHost: string | null
	/** Origin host is a PlanetScale gateway (`*.psdb.cloud`) — brands the row even without an inventory match. */
	readonly isPlanetScaleHost: boolean
	/** Set when the origin database matched the org's PlanetScale inventory. */
	readonly matched?: {
		/** Inventory database name (canonical casing). */
		readonly name: string
		/** Product kind: "mysql" (Vitess) or "postgresql". */
		readonly kind: string
	}
}

/**
 * PlanetScale connection hosts live under `psdb.cloud` (`aws.connect.psdb.cloud`
 * MySQL gateways, per-database Postgres hosts, `metrics.psdb.cloud`).
 */
export const isPlanetScaleHost = (host: string | null): boolean =>
	host !== null && /\.psdb\.cloud$/i.test(host)

/** "postgres" | "postgresql" ↔ "postgresql", "mysql" ↔ "mysql"; unknown schemes match nothing. */
const kindForScheme = (scheme: string): string | null => {
	const s = scheme.toLowerCase()
	if (s === "mysql") return "mysql"
	if (s === "postgres" || s === "postgresql") return "postgresql"
	return null
}

/**
 * Match Hyperdrive configs against the PlanetScale inventory (the map view's
 * lowercased-name Map). The origin database name is the reliable join key — for
 * Vitess MySQL the host is a shared regional gateway and the database rides the
 * username, but `origin.database` still carries the name. A scheme↔kind mismatch
 * drops the match (a coincidental name collision, not the same database).
 */
export function matchHyperdriveConfigs(
	configs: ReadonlyArray<HyperdriveConfigInput>,
	planetscaleDatabases: ReadonlyMap<string, { name: string; kind: string }>,
): HyperdriveNodeInfo[] {
	return configs.map((config) => {
		const candidate = planetscaleDatabases.get(config.originDatabase.toLowerCase())
		const expectedKind = kindForScheme(config.originScheme)
		const matched =
			candidate !== undefined && expectedKind !== null && candidate.kind === expectedKind
				? { name: candidate.name, kind: candidate.kind }
				: undefined
		return {
			id: config.id,
			name: config.name,
			originDatabase: config.originDatabase,
			originScheme: config.originScheme,
			originHost: config.originHost,
			isPlanetScaleHost: isPlanetScaleHost(config.originHost),
			...(matched === undefined ? {} : { matched }),
		}
	})
}
