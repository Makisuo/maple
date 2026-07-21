import { NORMALIZED_SPAN_NAME_SQL } from "../../tinybird/span-display-name"
import type { BackfillSpec } from "../backfill"

/**
 * Migration 0008 — minutely service-operation rollup.
 *
 * The migration installs the empty target and its live-write MV only. Historical
 * backfill is deliberately a separate, chunkable operation: customer collectors
 * can write directly to BYO ClickHouse during schema apply, so an automatic
 * backfill/MV cutover cannot be gap-free. Rollout must pause writes, truncate the
 * target, execute {@link serviceOperationsMinutelyBackfill}, verify parity, and
 * then resume writes before enabling hybrid reads.
 */
export const serviceOperationsMinutelyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_operations_minutely",
	columns: [
		"OrgId",
		"Minute",
		"ServiceName",
		"DeploymentEnv",
		"SpanName",
		"SpanCount",
		"EstimatedSpanCount",
		"ErrorCount",
		"EstimatedErrorCount",
		"DurationSum",
		"DurationQuantiles",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: `OrgId,
  toStartOfMinute(toDateTime(Timestamp)) AS Minute,
  ServiceName,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ${NORMALIZED_SPAN_NAME_SQL} AS SpanName,
  count() AS SpanCount,
  sum(SampleRate) AS EstimatedSpanCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration)) AS DurationSum,
  quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles`,
	groupBy: "OrgId, Minute, ServiceName, DeploymentEnv, SpanName",
}

export const migration_0008_service_operations_minutely = {
	version: 8,
	description: "Add the minutely service-operation rollup and its live-write materialized view",
	statements: [
		"DROP VIEW IF EXISTS service_operations_minutely_mv",
		`CREATE TABLE IF NOT EXISTS service_operations_minutely (
  OrgId LowCardinality(String),
  Minute DateTime,
  ServiceName LowCardinality(String),
  DeploymentEnv LowCardinality(String),
  SpanName String,
  SpanCount SimpleAggregateFunction(sum, UInt64),
  EstimatedSpanCount SimpleAggregateFunction(sum, Float64),
  ErrorCount SimpleAggregateFunction(sum, UInt64),
  EstimatedErrorCount SimpleAggregateFunction(sum, Float64),
  DurationSum SimpleAggregateFunction(sum, Float64),
  DurationQuantiles AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Minute)
ORDER BY (OrgId, ServiceName, DeploymentEnv, Minute, SpanName)
TTL toDate(Minute) + INTERVAL 90 DAY`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_minutely_mv TO service_operations_minutely AS
SELECT
  OrgId,
  toStartOfMinute(toDateTime(Timestamp)) AS Minute,
  ServiceName,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ${NORMALIZED_SPAN_NAME_SQL} AS SpanName,
  count() AS SpanCount,
  sum(SampleRate) AS EstimatedSpanCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration)) AS DurationSum,
  quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles
FROM traces
GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, SpanName`,
	],
} as const
