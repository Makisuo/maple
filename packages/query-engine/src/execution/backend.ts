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
import { Option } from "effect"
import { parseUrl } from "@maple/domain/url"

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

/**
 * OTel target identity of a resolved backend: what `db.namespace` and
 * `server.address` a query span against it should carry.
 *
 * These are what make a query span join the SAME service-map node as the
 * ingest gateway's writes to the same warehouse. A span with a `db.system.name`
 * but no namespace and no address collapses into the per-system generic node,
 * so `alerting` reading Tinybird used to appear as a second, nameless
 * "tinybird" database sitting next to the one `ingest` writes to.
 */
export interface WarehouseTargetIdentity {
	/** Empty when the backend has no database concept (Tinybird: the workspace rides the token). */
	readonly namespace: string
	readonly address: string
}

/**
 * Bare hostname of a URL, or the input unchanged when it isn't one.
 *
 * Normalizing matters for node identity: the gateway records `api.tinybird.co`
 * (host only), so a config carrying `https://api.tinybird.co` has to reduce to
 * the same string or the two sides land on different nodes again.
 */
const hostOf = (urlOrHost: string): string => {
	const trimmed = urlOrHost.trim()
	if (trimmed === "") return ""
	return Option.match(parseUrl(trimmed.includes("://") ? trimmed : `https://${trimmed}`), {
		onNone: () => trimmed,
		onSome: (url) => url.host,
	})
}

export const warehouseTargetIdentity = (config: ResolvedWarehouseConfig): WarehouseTargetIdentity =>
	config.kind === "tinybird"
		? { namespace: "", address: hostOf(config.host) }
		: { namespace: config.database, address: hostOf(config.url) }

/**
 * `warehouseTargetIdentity` as span attributes, empty values omitted — an
 * explicit `""` would defeat the read side's `nullIf(...)` coalesce chain and
 * still land the span on the generic node.
 */
export const warehouseTargetAttributes = (config: ResolvedWarehouseConfig): Record<string, string> => {
	const { namespace, address } = warehouseTargetIdentity(config)
	return {
		...(!(namespace === "") ? { "db.namespace": namespace } : undefined),
		...(!(address === "") ? { "server.address": address } : undefined),
	}
}

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
	 * Where the wire format is declared. The official ClickHouse client sets it
	 * per request and rejects a statement that carries its own `FORMAT` clause;
	 * Tinybird's `/v0/sql` has no such channel and reads it from the statement.
	 * The executor applies this so no driver has to re-derive it from SQL text.
	 */
	readonly wireFormat: "in-statement" | "out-of-band"
	/**
	 * The format a driver reading `wireFormat: "in-statement"` expects, applied
	 * by the executor when the statement does not already name one.
	 */
	readonly statementFormat: string | undefined
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
	/**
	 * True when this backend runs the schema *we* deploy, so its columns and
	 * skip indices are known at compile time and capability probing is both
	 * unnecessary and — on Tinybird — impossible (`system.*` answers `403`
	 * through the SDK and takes ~2.2s through the gateway). BYO ClickHouse is
	 * the user's own cluster and must still be inspected live; `chdb` applies
	 * the same generated schema but is cheap to probe and can lag a migration,
	 * so it keeps the live answer too.
	 */
	readonly managedSchema: boolean
}

/** Single source of truth for per-backend behavior. */
export const BackendDialect: Record<WarehouseBackendKind, WarehouseBackendDialect> = {
	tinybird: {
		driver: "tinybird-sdk",
		dbClient: "tinybird-sdk",
		stripTinybirdRestrictedSettings: true,
		wireFormat: "in-statement",
		statementFormat: "FORMAT JSON",
		dbSystemName: "tinybird",
		peerService: "tinybird",
		// The SDK's /v0/sql JSON already returns 64-bit ints as numbers.
		unquote64BitIntegers: false,
		managedSchema: true,
	},
	"tinybird-gateway": {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: true,
		wireFormat: "out-of-band",
		statementFormat: undefined,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
		unquote64BitIntegers: true,
		managedSchema: true,
	},
	clickhouse: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		wireFormat: "out-of-band",
		statementFormat: undefined,
		dbSystemName: "clickhouse",
		peerService: "clickhouse",
		unquote64BitIntegers: true,
		managedSchema: false,
	},
	chdb: {
		driver: "clickhouse-web",
		dbClient: "clickhouse",
		stripTinybirdRestrictedSettings: false,
		wireFormat: "out-of-band",
		statementFormat: undefined,
		dbSystemName: "clickhouse",
		peerService: "chdb",
		unquote64BitIntegers: true,
		managedSchema: false,
	},
} satisfies Record<WarehouseBackendKind, WarehouseBackendDialect>
