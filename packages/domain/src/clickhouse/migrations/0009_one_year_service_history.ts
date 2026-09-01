import type { BackfillSpec } from "../backfill"

/**
 * Coordinated backfill for the 30 days still present in the
 * service_overview_spans projection. Migration 0009 runs it before attaching
 * the live MV, so retained rows and future insert blocks cannot double-count.
 */
export const serviceOverviewHourlyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_overview_hourly",
	columns: [
		"OrgId",
		"Hour",
		"ServiceName",
		"DeploymentEnv",
		"ServiceNamespace",
		"CommitSha",
		"SpanCount",
		"EstimatedSpanCount",
		"ErrorCount",
		"EstimatedErrorCount",
		"DurationSum",
		"DurationQuantiles",
		"FirstSeen",
		"ApdexSatisfiedCount",
		"ApdexToleratingCount",
	],
	from: "service_overview_spans",
	tsColumn: "Timestamp",
	select: `OrgId,
  toStartOfHour(Timestamp) AS Hour,
  ServiceName,
  DeploymentEnv,
  ServiceNamespace,
  CommitSha,
  count() AS SpanCount,
  sum(SampleRate) AS EstimatedSpanCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration)) AS DurationSum,
  quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
  min(Timestamp) AS FirstSeen,
  countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,
  countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount`,
	groupBy: "OrgId, Hour, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha",
}

/**
 * Coordinated backfill for the 90 days retained in the minutely operation
 * table. Aggregate states are merged without lossy finalization; the live
 * cascading MV is attached only after this step.
 */
export const serviceOperationsHourlyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_operations_hourly",
	columns: [
		"OrgId",
		"Hour",
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
	from: "service_operations_minutely",
	tsColumn: "Minute",
	select: `OrgId,
  toStartOfHour(Minute) AS Hour,
  ServiceName,
  DeploymentEnv,
  SpanName,
  sum(SpanCount) AS SpanCount,
  sum(EstimatedSpanCount) AS EstimatedSpanCount,
  sum(ErrorCount) AS ErrorCount,
  sum(EstimatedErrorCount) AS EstimatedErrorCount,
  sum(DurationSum) AS DurationSum,
  quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles`,
	groupBy: "OrgId, Hour, ServiceName, DeploymentEnv, SpanName",
}

const annualTtlTables = [
	["alert_checks", "toDate(Timestamp)"],
	["service_map_edges_hourly", "toDate(Hour)"],
	["service_map_db_edges_hourly", "toDate(Hour)"],
	["service_map_db_query_shapes_hourly", "toDate(Hour)"],
	["service_external_edges_hourly", "toDate(Hour)"],
	["service_address_resolutions_hourly", "toDate(Hour)"],
	["service_platforms_hourly", "toDate(Hour)"],
	["traces_aggregates_hourly", "toDate(Hour)"],
	["logs_aggregates_hourly", "toDate(Hour)"],
] as const

export const migration_0009_one_year_service_history = {
	version: 9,
	description:
		"Add annual service overview/operation rollups and extend summarized alert/service retention",
	statements: [
		...annualTtlTables.map(
			([table, timestamp]) => `ALTER TABLE ${table} MODIFY TTL ${timestamp} + INTERVAL 365 DAY`,
		),
		`CREATE TABLE IF NOT EXISTS service_overview_hourly (
  OrgId LowCardinality(String),
  Hour DateTime,
  ServiceName LowCardinality(String),
  DeploymentEnv LowCardinality(String),
  ServiceNamespace LowCardinality(String),
  CommitSha LowCardinality(String),
  SpanCount SimpleAggregateFunction(sum, UInt64),
  EstimatedSpanCount SimpleAggregateFunction(sum, Float64),
  ErrorCount SimpleAggregateFunction(sum, UInt64),
  EstimatedErrorCount SimpleAggregateFunction(sum, Float64),
  DurationSum SimpleAggregateFunction(sum, Float64),
  DurationQuantiles AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt64),
  FirstSeen SimpleAggregateFunction(min, DateTime),
  ApdexSatisfiedCount SimpleAggregateFunction(sum, UInt64),
  ApdexToleratingCount SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Hour)
ORDER BY (OrgId, ServiceName, Hour, DeploymentEnv, ServiceNamespace, CommitSha)
TTL toDate(Hour) + INTERVAL 365 DAY`,
		`CREATE TABLE IF NOT EXISTS service_operations_hourly (
  OrgId LowCardinality(String),
  Hour DateTime,
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
PARTITION BY toYYYYMM(Hour)
ORDER BY (OrgId, ServiceName, DeploymentEnv, Hour, SpanName)
TTL toDate(Hour) + INTERVAL 365 DAY`,
		// DROP → TRUNCATE → backfill → CREATE MV, the 0015 cutover shape. The
		// truncates make a re-apply of a partially failed run converge instead of
		// doubling the additive sum aggregates; safe only because both views are
		// detached first, so nothing writes the targets during the backfills.
		"DROP VIEW IF EXISTS service_overview_hourly_mv",
		"DROP VIEW IF EXISTS service_operations_hourly_mv",
		"TRUNCATE TABLE IF EXISTS service_overview_hourly",
		"TRUNCATE TABLE IF EXISTS service_operations_hourly",
		serviceOverviewHourlyBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_hourly_mv TO service_overview_hourly AS
SELECT
  OrgId,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  ServiceName,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ResourceAttributes['service.namespace'] AS ServiceNamespace,
  ResourceAttributes['deployment.commit_sha'] AS CommitSha,
  count() AS SpanCount,
  sum(SampleRate) AS EstimatedSpanCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration)) AS DurationSum,
  quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
  min(toDateTime(Timestamp)) AS FirstSeen,
  countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,
  countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount
FROM traces
WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha`,
		serviceOperationsHourlyBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_hourly_mv TO service_operations_hourly AS
SELECT
  OrgId,
  toStartOfHour(Minute) AS Hour,
  ServiceName,
  DeploymentEnv,
  SpanName,
  sum(SpanCount) AS SpanCount,
  sum(EstimatedSpanCount) AS EstimatedSpanCount,
  sum(ErrorCount) AS ErrorCount,
  sum(EstimatedErrorCount) AS EstimatedErrorCount,
  sum(DurationSum) AS DurationSum,
  quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles
FROM service_operations_minutely
GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, SpanName`,
	],
} as const
