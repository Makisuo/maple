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
	/**
	 * ClickHouse JSON formats quote 64-bit integers by default
	 * (`output_format_json_quote_64bit_integers=1`), so `count()`/`sum()`/
	 * `uniqExact()` arrive as strings on ClickHouse-protocol backends while the
	 * Tinybird SDK returns numbers. Setting the flag to 0 restores wire parity so
	 * every query decodes identically on both — magnitudes above 2^53 lose
	 * precision either way (the existing managed-Tinybird contract); identity
	 * UInt64s (hashes/ids) must be `toString()`-wrapped in the SELECT, which the
	 * SQL-catalog e2e sweep enforces.
	 */
	readonly unquote64BitIntegers: boolean
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
		// The SDK's /v0/sql JSON already returns 64-bit ints as numbers.
		unquote64BitIntegers: false,
	},
	"tinybird-gateway": {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: true,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
		unquote64BitIntegers: true,
	},
	clickhouse: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
		unquote64BitIntegers: true,
	},
	chdb: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		normalizeSqlForClient: true,
		dbSystemName: "clickhouse",
		peerService: "chdb",
		unquote64BitIntegers: true,
	},
}
