import {
	DB_NAMESPACE_ATTR_SQL,
	DB_QUERY_KEY_SQL,
	DB_QUERY_LABEL_SQL,
	DB_STATEMENT_SQL,
	DB_SYSTEM_ATTR_SQL,
} from "../../tinybird/db-query-shape-sql"

/**
 * Migration 0007 — collapse Cloudflare Hyperdrive namespaces on the DB rollups.
 *
 * Cloudflare Hyperdrive presents Postgres to the driver with its 32-char hex
 * config ID as the database name, and there is a *separate config per deployment
 * environment*, so migration 0006's per-`DbNamespace` split exploded one logical
 * database into a fresh service-map node per Worker/PR-preview binding — all
 * fronting the same database. `DB_NAMESPACE_ATTR_SQL` now folds those opaque IDs
 * (and `*.hyperdrive.local` hosts) into the `HYPERDRIVE_DB_NAMESPACE` sentinel,
 * which the UI brands as a single "Hyperdrive" node.
 *
 * This migration only **recreates the two MVs** so new rows write the collapsed
 * value; the AggregatingMergeTree tables and their sorting keys are unchanged
 * (still `… , DbSystem, DbNamespace [, QueryKey]`). Sealed rows written before
 * this deploy still carry the raw hex, but the read path collapses them on read
 * (`collapseHyperdriveNs` in `@maple/query-engine`), so no table rebuild or
 * backfill is needed — the stale hex simply ages out at the 90d rollup TTL.
 *
 * The MV bodies are built from the same `db-query-shape-sql.ts` fragments the
 * Tinybird write-side materializations use, keeping the sealed-hour and
 * raw-fallback branches byte-identical by construction.
 */

const DB_SPAN_WHERE = `SpanKind IN ('Client', 'Producer')
  AND ${DB_SYSTEM_ATTR_SQL} != ''
  AND ServiceName != ''`

export const migration_0007_db_namespace_hyperdrive = {
	version: 7,
	description:
		"Collapse Cloudflare Hyperdrive DbNamespace hashes into the 'hyperdrive' sentinel by recreating the service-map DB-edge/query-shape MVs",
	statements: [
		// --- service_map_db_edges_hourly ------------------------------------
		"DROP VIEW IF EXISTS service_map_db_edges_hourly_mv",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_db_edges_hourly_mv TO service_map_db_edges_hourly AS
SELECT
  OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
  ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  count() AS CallCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sum(Duration / 1000000) AS DurationSumMs,
  max(Duration / 1000000) AS MaxDurationMs,
  countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
  countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,
  sum(SampleRate) AS SampleRateSum
FROM traces
WHERE ${DB_SPAN_WHERE}
GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv`,

		// --- service_map_db_query_shapes_hourly -----------------------------
		"DROP VIEW IF EXISTS service_map_db_query_shapes_hourly_mv",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_db_query_shapes_hourly_mv TO service_map_db_query_shapes_hourly AS
SELECT
  OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
  ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ${DB_QUERY_KEY_SQL} AS QueryKey,
  any(substring(${DB_QUERY_LABEL_SQL}, 1, 220)) AS QueryLabel,
  any(substring(${DB_STATEMENT_SQL}, 1, 1000)) AS SampleStatement,
  count() AS CallCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sum(SampleRate) AS EstimatedCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration) * SampleRate / 1000000) AS WeightedDurationSumMs,
  quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles
FROM traces
WHERE ${DB_SPAN_WHERE}
GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv, QueryKey`,
	],
} as const
