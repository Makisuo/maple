/**
 * The warehouse backends Maple can execute against, named for what they ARE
 * instead of being encoded as protocol × policy flag combinations:
 *
 * - `tinybird`         — managed Tinybird via its SDK (`/v0/sql` + Events API)
 * - `tinybird-gateway` — managed Tinybird via its ClickHouse-compatible gateway
 *                        (`CLICKHOUSE_URL` + `CLICKHOUSE_PROVIDER=tinybird`)
 * - `clickhouse`       — vanilla ClickHouse: a per-org BYO cluster or an
 *                        env-level self-hosted read endpoint
 * - `chdb`             — the embedded chDB engine behind the local `maple` binary
 */
export type WarehouseBackendKind = "tinybird" | "tinybird-gateway" | "clickhouse" | "chdb"

export interface TinybirdBackendConfig {
	readonly kind: "tinybird"
	readonly host: string
	readonly token: string
}

export interface ClickHouseProtocolBackendConfig {
	readonly kind: Exclude<WarehouseBackendKind, "tinybird">
	readonly url: string
	readonly username: string
	readonly password: string
	readonly database: string
}

/** Resolved upstream connection config for a tenant's queries. */
export type ResolvedWarehouseConfig = TinybirdBackendConfig | ClickHouseProtocolBackendConfig

export interface WarehouseBackendDialect {
	readonly driver: "tinybird-sdk" | "clickhouse-web"
	/** Legacy driver label emitted as `db.client` on canonical query spans. */
	readonly dbClient: "tinybird-sdk" | "clickhouse"
	/**
	 * Tinybird's managed warehouse rejects some ClickHouse settings (e.g.
	 * "Usage of setting 'max_block_size' is restricted") — through the SDK AND
	 * through its ClickHouse-compatible gateway. Vanilla ClickHouse allows them.
	 */
	readonly stripTinybirdRestrictedSettings: boolean
	/**
	 * The official ClickHouse client rejects a trailing `FORMAT …`/`;` (it sets
	 * the format itself); Tinybird's `/v0/sql` requires them.
	 */
	readonly normalizeSqlForClient: boolean
	/**
	 * OTel database-system identity. chDB implements the ClickHouse interface,
	 * so its system remains `clickhouse` even though the logical peer is `chdb`.
	 */
	readonly dbSystemName: "tinybird" | "clickhouse"
	/** Logical destination used by the service-map `peer.service` edge. */
	readonly peerService: string
}

/** Single source of truth for per-backend behavior. */
export const BackendDialect: Record<WarehouseBackendKind, WarehouseBackendDialect> = {
	tinybird: {
		driver: "tinybird-sdk",
		dbClient: "tinybird-sdk",
		stripTinybirdRestrictedSettings: true,
		normalizeSqlForClient: false,
		dbSystemName: "tinybird",
		peerService: "tinybird",
	},
	"tinybird-gateway": {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: true,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
	},
	clickhouse: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
	},
	chdb: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "chdb",
	},
}
