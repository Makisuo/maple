/**
 * Migration 0013 — error evaluator rollup and Events API-compatible
 * service-map rollup ingestion.
 *
 * Existing v12 ClickHouse installs already have `error_events` and the
 * deployment-safe `error_events_by_time_mv` triggered by `traces`. Add the new
 * minutely evaluator path without replacing that existing view: the evaluator
 * bootstraps its first window from error_events_by_time, then consumes new
 * minute buckets from this incremental rollup.
 *
 * Tinybird rejects aggregate-state column types in datasources that declare
 * JSONPaths, while direct NDJSON ingestion requires JSONPaths. Use the same
 * portable shape in native ClickHouse: a plain-schema Null table receives the
 * scheduled rollup, fires an insert-trigger MV, and retains no duplicate copy.
 * The existing aggregate target and all historical rows remain untouched.
 *
 * This migration gates ingest because `ServiceMapRollupService` writes to the
 * new bridge after this version ships.
 */
export const migration_0013_service_map_ingest_bridge = {
	version: 13,
	description: "Add the minutely error evaluator rollup and a Null-engine service-map ingress bridge",
	statements: [
		`CREATE TABLE IF NOT EXISTS error_fingerprints_minutely (
  OrgId LowCardinality(String),
  Minute DateTime,
  FingerprintHash UInt64,
  ServiceName SimpleAggregateFunction(anyLast, String),
  ExceptionType SimpleAggregateFunction(anyLast, String),
  ExceptionMessage SimpleAggregateFunction(anyLast, String),
  ErrorLabel SimpleAggregateFunction(anyLast, String),
  TopFrame SimpleAggregateFunction(anyLast, String),
  OccurrenceCount SimpleAggregateFunction(sum, UInt64),
  FirstSeen SimpleAggregateFunction(min, DateTime),
  LastSeen SimpleAggregateFunction(max, DateTime)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Minute)
ORDER BY (OrgId, Minute, FingerprintHash)
TTL Minute + INTERVAL 90 DAY`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS error_fingerprints_minutely_mv TO error_fingerprints_minutely AS
SELECT
  OrgId,
  toStartOfMinute(Timestamp) AS Minute,
  FingerprintHash,
  anyLast(ServiceName) AS ServiceName,
  anyLast(ExceptionType) AS ExceptionType,
  anyLast(ExceptionMessage) AS ExceptionMessage,
  anyLast(ErrorLabel) AS ErrorLabel,
  anyLast(TopFrame) AS TopFrame,
  count() AS OccurrenceCount,
  min(Timestamp) AS FirstSeen,
  max(Timestamp) AS LastSeen
FROM error_events
GROUP BY OrgId, Minute, FingerprintHash`,
		`CREATE TABLE IF NOT EXISTS service_map_edges_hourly_ingest (
  OrgId LowCardinality(String),
  Hour DateTime,
  SourceService LowCardinality(String),
  TargetService String,
  DeploymentEnv LowCardinality(String),
  CallCount UInt64,
  ErrorCount UInt64,
  DurationSumMs Float64,
  MaxDurationMs Float64,
  SampledSpanCount UInt64,
  UnsampledSpanCount UInt64,
  SampleRateSum Float64
)
ENGINE = Null`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_edges_hourly_ingest_mv TO service_map_edges_hourly AS
SELECT
  OrgId,
  Hour,
  SourceService,
  TargetService,
  DeploymentEnv,
  CallCount,
  ErrorCount,
  DurationSumMs,
  MaxDurationMs,
  SampledSpanCount,
  UnsampledSpanCount,
  SampleRateSum
FROM service_map_edges_hourly_ingest`,
	],
} as const
