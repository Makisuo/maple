// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { Chdb } from "../src/server/chdb"
import { LOCAL_SCHEMA_SQL } from "../src/server/schema-identity"
import { markStoreClosedDurable, markStoreOpenDurable } from "../src/server/store-version"

const [dataDir, configFile] = process.argv.slice(2)
if (!dataDir || !configFile)
	throw new Error("usage: native-service-map-ingest-bridge-probe.ts <data-dir> <config-file>")

const firstRow = <A>(jsonEachRow: string): A => {
	const line = jsonEachRow
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0)
	if (!line) throw new Error("native service-map bridge query returned no rows")
	return JSON.parse(line) as A
}

await markStoreOpenDurable(dataDir)
let db: Chdb | undefined
let closed = false
try {
	db = Chdb.open({ dataDir, configFile, schemaSql: LOCAL_SCHEMA_SQL, bootstrapSchema: false })
	db.exec(`INSERT INTO service_map_edges_hourly_ingest (
  OrgId, Hour, SourceService, TargetService, DeploymentEnv,
  CallCount, ErrorCount, DurationSumMs, MaxDurationMs,
  SampledSpanCount, UnsampledSpanCount, SampleRateSum
) VALUES (
  'native-migration', toStartOfHour(now()), 'frontend', 'backend', 'test',
  7, 2, 42.5, 12.5, 5, 2, 9.5
)`)

	const target = firstRow<{ count: string }>(
		db.query(`SELECT toString(sum(CallCount)) AS count
FROM service_map_edges_hourly
WHERE OrgId = 'native-migration'
  AND SourceService = 'frontend'
  AND TargetService = 'backend'`),
	)
	if (target.count !== "7")
		throw new Error(`service-map ingress bridge expected 7 calls, got ${target.count}`)

	const source = firstRow<{ count: string }>(
		db.query("SELECT toString(count()) AS count FROM service_map_edges_hourly_ingest"),
	)
	if (source.count !== "0")
		throw new Error(`Null-engine service-map ingress expected 0 retained rows, got ${source.count}`)

	// v2 temporarily changed error_events_by_time_mv to cascade from
	// error_events. The v2 -> v3 migration must recreate the deployment-safe
	// traces trigger while preserving the new error_events -> minutely cascade.
	db.exec(`INSERT INTO traces (
  OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState,
  SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes,
  StatusCode, StatusMessage
) SELECT
  'native-migration', now64(9), 'trace-v3-error-trigger', 'span-v3-error-trigger', '', '',
  'error trigger probe', 'Server', 'native-migration',
  map('deployment.environment', 'test'), map(), 'Error', 'v3 trigger probe'`)

	const timeOrderedError = firstRow<{ count: string }>(
		db.query(`SELECT toString(count()) AS count
FROM error_events_by_time
WHERE OrgId = 'native-migration' AND TraceId = 'trace-v3-error-trigger'`),
	)
	if (timeOrderedError.count !== "1")
		throw new Error(`restored error_events_by_time trigger expected 1 row, got ${timeOrderedError.count}`)

	const minutelyError = firstRow<{ count: string }>(
		db.query(`SELECT toString(sum(OccurrenceCount)) AS count
FROM error_fingerprints_minutely
WHERE OrgId = 'native-migration' AND ErrorLabel = 'v3 trigger probe'`),
	)
	if (minutelyError.count !== "1")
		throw new Error(`minutely error cascade expected 1 occurrence, got ${minutelyError.count}`)

	db.close()
	db = undefined
	closed = true
} finally {
	if (db !== undefined) db.close()
	if (closed) await markStoreClosedDurable(dataDir)
}
