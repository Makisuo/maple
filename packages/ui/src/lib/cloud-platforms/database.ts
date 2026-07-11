import { DatabaseIcon } from "../../components/icons"
import type { CloudPlatformAdapter, CloudPlatformField } from "./types"
import { pickAttr } from "./types"

// Generic OpenTelemetry database-client span annotations. Any DB-instrumented
// service (PostgreSQL, MySQL, ClickHouse, Redis, MongoDB, …) emits the `db.*`
// semantic-convention attributes on its CLIENT span; this adapter normalizes
// them into the shared summary block so a query's shape, target, and result
// size read inline in the trace — for every database, with no per-DB code.
//
// Reuses the same span-annotation registry as the cloud-platform adapters
// (cloudflare.ts, …); the normalized `CloudPlatformInfo` shape is generic
// enough to describe a database call as well as a serverless invocation.

/** Display names for the well-known `db.system.name` values (stable semconv). */
const DB_SYSTEM_LABELS: Record<string, string> = {
	postgresql: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	clickhouse: "ClickHouse",
	redis: "Redis",
	mongodb: "MongoDB",
	elasticsearch: "Elasticsearch",
	opensearch: "OpenSearch",
	cassandra: "Cassandra",
	cockroachdb: "CockroachDB",
	sqlite: "SQLite",
	oracle: "Oracle",
	db2: "Db2",
	"microsoft.sql_server": "SQL Server",
	mssql: "SQL Server",
	"aws.dynamodb": "DynamoDB",
	dynamodb: "DynamoDB",
	"aws.redshift": "Redshift",
	redshift: "Redshift",
	"gcp.spanner": "Spanner",
	"azure.cosmosdb": "Cosmos DB",
	cosmosdb: "Cosmos DB",
	memcached: "Memcached",
	couchbase: "Couchbase",
	couchdb: "CouchDB",
	neo4j: "Neo4j",
	snowflake: "Snowflake",
	trino: "Trino",
	presto: "Presto",
	hive: "Hive",
	spanner: "Spanner",
}

/** Brand-ish accent per system; a small tint on the 12px icon, muted otherwise. */
const DB_SYSTEM_ACCENTS: Record<string, string> = {
	postgresql: "text-[#336791]",
	mysql: "text-[#00758F]",
	mariadb: "text-[#1F7A8C]",
	clickhouse: "text-[#F5B400]",
	redis: "text-[#DC382D]",
	mongodb: "text-[#13AA52]",
	elasticsearch: "text-[#00BFB3]",
	opensearch: "text-[#00BFB3]",
	cassandra: "text-[#1287B1]",
	cockroachdb: "text-[#6933FF]",
	sqlite: "text-[#0F80CC]",
	oracle: "text-[#C74634]",
	mssql: "text-[#CC2927]",
	"microsoft.sql_server": "text-[#CC2927]",
	dynamodb: "text-[#4053D6]",
	"aws.dynamodb": "text-[#4053D6]",
	redshift: "text-[#8C4FFF]",
	snowflake: "text-[#29B5E8]",
}

/** "microsoft.sql_server" → "SQL Server"; unknown → title-cased last segment. */
function humanizeDbSystem(system: string): string {
	const known = DB_SYSTEM_LABELS[system.toLowerCase()]
	if (known) return known
	const tail = system.split(".").pop() ?? system
	return tail
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ")
}

export const databaseAdapter: CloudPlatformAdapter = {
	id: "database",
	detect(attrs) {
		// Require a real, non-empty `db.system.name` VALUE (stable semconv) — with
		// the legacy `db.system` fallback. Never a key-presence check: the trimmed
		// tree-view projection emits requested keys with empty-string values on
		// every span, so presence alone would flag non-DB spans.
		const system = pickAttr(attrs, "db.system.name", "db.system")
		if (!system) return null

		const operation = pickAttr(attrs, "db.operation.name", "db.operation")
		const namespace = pickAttr(attrs, "db.namespace")
		const collection = pickAttr(attrs, "db.collection.name")
		const rows = pickAttr(attrs, "db.response.returned_rows")
		const batch = pickAttr(attrs, "db.operation.batch.size")
		const statusCode = pickAttr(attrs, "db.response.status_code")
		const serverAddress = pickAttr(attrs, "server.address", "network.peer.address")
		const serverPort = pickAttr(attrs, "server.port", "network.peer.port")
		const errorType = pickAttr(attrs, "error.type")

		const fields: CloudPlatformField[] = []
		if (operation) fields.push({ label: "Operation", value: operation })
		if (namespace) fields.push({ label: "Namespace", value: namespace })
		if (collection) fields.push({ label: "Table", value: collection })
		if (rows) fields.push({ label: "Rows returned", value: rows })
		// Per spec, `db.operation.batch.size` is only emitted for batches (never 1).
		if (batch) fields.push({ label: "Batch size", value: batch })
		if (serverAddress)
			fields.push({
				label: "Server",
				value: serverPort ? `${serverAddress}:${serverPort}` : serverAddress,
				copyable: true,
			})
		if (statusCode) fields.push({ label: "Status", value: statusCode })

		const outcome = errorType ? { value: errorType, bad: true } : null

		return {
			id: "database",
			label: humanizeDbSystem(system),
			kind: "Query",
			Icon: DatabaseIcon,
			accentClassName: DB_SYSTEM_ACCENTS[system.toLowerCase()] ?? "text-muted-foreground",
			edge: null,
			location: null,
			outcome,
			fields,
		}
	},
}
