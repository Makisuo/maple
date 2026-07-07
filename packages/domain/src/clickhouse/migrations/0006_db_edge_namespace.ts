import {
	DB_NAMESPACE_ATTR_SQL,
	DB_QUERY_KEY_SQL,
	DB_QUERY_LABEL_SQL,
	DB_STATEMENT_SQL,
	DB_SYSTEM_ATTR_SQL,
} from "../../tinybird/db-query-shape-sql"
import type { BackfillSpec } from "../backfill"

/**
 * Migration 0006 — database identity on service-map DB rollups.
 *
 * Adds `DbNamespace` (best-available database identity: `db.namespace` →
 * `db.name` → `server.address` → `net.peer.name`, see `DB_NAMESPACE_ATTR_SQL`)
 * as a grouping dimension on `service_map_db_edges_hourly` and
 * `service_map_db_query_shapes_hourly`, so distinct databases of the same
 * system (e.g. two Postgres databases) get distinct service-map nodes instead
 * of collapsing into one generic per-system node.
 *
 * Both tables are AggregatingMergeTree whose grouping dimensions must live in
 * ORDER BY, so we rebuild/swap (`__v6` + RENAME) rather than altering the
 * immutable key — same recipe as `logs_aggregates_hourly__v4` in migration 0004.
 *
 * Existing rows older than the `traces` retention are carried forward with
 * `DbNamespace = ''` (the rollups' 90d TTL outlives the 30d source, so they
 * cannot be recomputed — those hours keep rendering as the per-system generic
 * node). The retained window is re-derived from `traces` via chunkable
 * {@link BackfillSpec}s so per-namespace history exists from day one.
 *
 * The MV bodies are built from the same `db-query-shape-sql.ts` fragments the
 * write-side materializations use, keeping the sealed-hour and raw-fallback
 * branches byte-identical by construction.
 */

/** Hours before the earliest retained trace: carry forward, can't recompute. */
const PRE_RETENTION_HOUR_PREDICATE = `Hour < (
  SELECT if(count() = 0, toDateTime('2100-01-01'), toStartOfHour(min(Timestamp)))
  FROM traces
)`

const DB_SPAN_WHERE = `SpanKind IN ('Client', 'Producer')
  AND ${DB_SYSTEM_ATTR_SQL} != ''
  AND ServiceName != ''`

const dbEdgesBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_map_db_edges_hourly__v6",
	columns: [
		"OrgId",
		"Hour",
		"ServiceName",
		"DbSystem",
		"DeploymentEnv",
		"CallCount",
		"ErrorCount",
		"DurationSumMs",
		"MaxDurationMs",
		"SampledSpanCount",
		"UnsampledSpanCount",
		"SampleRateSum",
		"DbNamespace",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: `OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  count() AS CallCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sum(Duration / 1000000) AS DurationSumMs,
  max(Duration / 1000000) AS MaxDurationMs,
  countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
  countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,
  sum(SampleRate) AS SampleRateSum,
  ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace`,
	where: DB_SPAN_WHERE,
	groupBy: "OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv",
}

const dbQueryShapesBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_map_db_query_shapes_hourly__v6",
	columns: [
		"OrgId",
		"Hour",
		"ServiceName",
		"DbSystem",
		"DeploymentEnv",
		"QueryKey",
		"QueryLabel",
		"SampleStatement",
		"CallCount",
		"ErrorCount",
		"EstimatedCount",
		"EstimatedErrorCount",
		"WeightedDurationSumMs",
		"DurationQuantiles",
		"DbNamespace",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: `OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ${DB_QUERY_KEY_SQL} AS QueryKey,
  any(substring(${DB_QUERY_LABEL_SQL}, 1, 220)) AS QueryLabel,
  any(substring(${DB_STATEMENT_SQL}, 1, 1000)) AS SampleStatement,
  count() AS CallCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sum(SampleRate) AS EstimatedCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration) * SampleRate / 1000000) AS WeightedDurationSumMs,
  quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles,
  ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace`,
	where: DB_SPAN_WHERE,
	groupBy: "OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv, QueryKey",
}

export const migration_0006_db_edge_namespace = {
	version: 6,
	description:
		"Split service-map DB rollups by database identity: rebuild db-edge/query-shape sorting keys with DbNamespace and recreate their MVs",
	statements: [
		// --- service_map_db_edges_hourly -----------------------------------
		"DROP VIEW IF EXISTS service_map_db_edges_hourly_mv",
		"DROP TABLE IF EXISTS service_map_db_edges_hourly__v6",
		`CREATE TABLE IF NOT EXISTS service_map_db_edges_hourly__v6 (
  OrgId LowCardinality(String),
  Hour DateTime,
  ServiceName LowCardinality(String),
  DbSystem LowCardinality(String),
  DeploymentEnv LowCardinality(String),
  CallCount SimpleAggregateFunction(sum, UInt64),
  ErrorCount SimpleAggregateFunction(sum, UInt64),
  DurationSumMs SimpleAggregateFunction(sum, Float64),
  MaxDurationMs SimpleAggregateFunction(max, Float64),
  SampledSpanCount SimpleAggregateFunction(sum, UInt64),
  UnsampledSpanCount SimpleAggregateFunction(sum, UInt64),
  SampleRateSum SimpleAggregateFunction(sum, Float64),
  DbNamespace LowCardinality(String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace)
TTL toDate(Hour) + INTERVAL 90 DAY`,
		// Carry pre-retention hours forward with '' (per-system generic node);
		// SimpleAggregateFunction/AggregateFunction values copy through row-wise
		// and re-merge in the new table.
		`INSERT INTO service_map_db_edges_hourly__v6 (
  OrgId, Hour, ServiceName, DbSystem, DeploymentEnv,
  CallCount, ErrorCount, DurationSumMs, MaxDurationMs,
  SampledSpanCount, UnsampledSpanCount, SampleRateSum,
  DbNamespace
)
SELECT
  OrgId, Hour, ServiceName, DbSystem, DeploymentEnv,
  CallCount, ErrorCount, DurationSumMs, MaxDurationMs,
  SampledSpanCount, UnsampledSpanCount, SampleRateSum,
  '' AS DbNamespace
FROM service_map_db_edges_hourly
WHERE ${PRE_RETENTION_HOUR_PREDICATE}`,
		dbEdgesBackfill,
		"DROP TABLE IF EXISTS service_map_db_edges_hourly__v6_old",
		"RENAME TABLE service_map_db_edges_hourly TO service_map_db_edges_hourly__v6_old, service_map_db_edges_hourly__v6 TO service_map_db_edges_hourly",
		"DROP TABLE IF EXISTS service_map_db_edges_hourly__v6_old",
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
		"DROP TABLE IF EXISTS service_map_db_query_shapes_hourly__v6",
		`CREATE TABLE IF NOT EXISTS service_map_db_query_shapes_hourly__v6 (
  OrgId LowCardinality(String),
  Hour DateTime,
  ServiceName LowCardinality(String),
  DbSystem LowCardinality(String),
  DeploymentEnv LowCardinality(String),
  QueryKey String,
  QueryLabel SimpleAggregateFunction(any, String),
  SampleStatement SimpleAggregateFunction(any, String),
  CallCount SimpleAggregateFunction(sum, UInt64),
  ErrorCount SimpleAggregateFunction(sum, UInt64),
  EstimatedCount SimpleAggregateFunction(sum, Float64),
  EstimatedErrorCount SimpleAggregateFunction(sum, Float64),
  WeightedDurationSumMs SimpleAggregateFunction(sum, Float64),
  DurationQuantiles AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32),
  DbNamespace LowCardinality(String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace, QueryKey)
TTL toDate(Hour) + INTERVAL 90 DAY`,
		`INSERT INTO service_map_db_query_shapes_hourly__v6 (
  OrgId, Hour, ServiceName, DbSystem, DeploymentEnv,
  QueryKey, QueryLabel, SampleStatement,
  CallCount, ErrorCount, EstimatedCount, EstimatedErrorCount,
  WeightedDurationSumMs, DurationQuantiles,
  DbNamespace
)
SELECT
  OrgId, Hour, ServiceName, DbSystem, DeploymentEnv,
  QueryKey, QueryLabel, SampleStatement,
  CallCount, ErrorCount, EstimatedCount, EstimatedErrorCount,
  WeightedDurationSumMs, DurationQuantiles,
  '' AS DbNamespace
FROM service_map_db_query_shapes_hourly
WHERE ${PRE_RETENTION_HOUR_PREDICATE}`,
		dbQueryShapesBackfill,
		"DROP TABLE IF EXISTS service_map_db_query_shapes_hourly__v6_old",
		"RENAME TABLE service_map_db_query_shapes_hourly TO service_map_db_query_shapes_hourly__v6_old, service_map_db_query_shapes_hourly__v6 TO service_map_db_query_shapes_hourly",
		"DROP TABLE IF EXISTS service_map_db_query_shapes_hourly__v6_old",
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
