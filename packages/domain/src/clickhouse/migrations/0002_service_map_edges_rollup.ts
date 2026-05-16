/**
 * Migration 0002 — service-map edge rollup.
 *
 * Modern OTEL instrumentation no longer emits the `peer.service` / `db.system`
 * span attributes — it emits `server.address` and `db.system.name`. The two
 * service-map edge materialized views filtered on the dead keys and therefore
 * produced zero rows, leaving the service map with no historical throughput.
 *
 * - `service_map_edges_hourly_mv` is dropped outright. An edge's downstream
 *   service can only be recovered by joining a Client/Producer span to its
 *   child Server/Consumer span — a cross-span join no MV can express.
 *   `service_map_edges_hourly` is now populated by the scheduled
 *   `ServiceMapRollupService` rollup; the table itself is kept.
 * - `service_map_db_edges_hourly_mv` is recreated keyed on `db.system.name`.
 * - `service_map_spans_mv` / `service_map_spans` drop the now-dead
 *   `PeerService` projection and column.
 *
 * DDL only — existing hourly buckets are not backfilled here. Run
 * `scripts/backfill-service-map-edges.ts` once after applying this migration.
 */
export const migration_0002_service_map_edges_rollup = {
	version: 2,
	description:
		"Service-map edge rollup: drop peer.service MV, rekey db edges on db.system.name, drop dead PeerService",
	statements: [
		// Replaced by the scheduled ServiceMapRollupService rollup.
		"DROP VIEW IF EXISTS service_map_edges_hourly_mv",
		// Recreate the db-edges MV keyed on the modern `db.system.name` attribute.
		"DROP VIEW IF EXISTS service_map_db_edges_hourly_mv",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_db_edges_hourly_mv TO service_map_db_edges_hourly AS
SELECT
  OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  SpanAttributes['db.system.name'] AS DbSystem,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  count() AS CallCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sum(Duration / 1000000) AS DurationSumMs,
  max(Duration / 1000000) AS MaxDurationMs,
  countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
  countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,
  sum(SampleRate) AS SampleRateSum
FROM traces
WHERE SpanKind IN ('Client', 'Producer')
  AND SpanAttributes['db.system.name'] != ''
  AND ServiceName != ''
GROUP BY OrgId, Hour, ServiceName, DbSystem, DeploymentEnv`,
		// Drop the dead PeerService projection/column from the spans projection.
		"DROP VIEW IF EXISTS service_map_spans_mv",
		"ALTER TABLE service_map_spans DROP COLUMN IF EXISTS PeerService",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_spans_mv TO service_map_spans AS
SELECT
  OrgId,
  toDateTime(Timestamp) AS Timestamp,
  TraceId,
  SpanId,
  ParentSpanId,
  ServiceName,
  SpanKind,
  Duration,
  StatusCode,
  TraceState,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv
FROM traces
WHERE SpanKind IN ('Client', 'Producer', 'Server', 'Consumer')`,
	],
} as const
