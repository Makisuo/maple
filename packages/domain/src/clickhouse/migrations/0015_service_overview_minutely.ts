import type { BackfillSpec } from "../backfill"

/**
 * Shared projection for the minutely service-overview rollup.
 *
 * Both the backfill below and the `CREATE MATERIALIZED VIEW` at the end of this
 * migration derive from this one definition of the aggregate. Two hand-copied
 * SELECTs are two chances for a backfilled minute and a live minute to disagree,
 * and the target has no dedup that would catch it.
 *
 * The backfill reads `service_overview_spans` while the MV reads `traces`, so
 * the column expressions differ in exactly two ways and no others: the
 * projection's `Timestamp` is already `toDateTime`-narrowed and its
 * `DeploymentEnv` / `ServiceNamespace` / `CommitSha` are already extracted from
 * `ResourceAttributes`.
 */
const MINUTELY_AGGREGATE_SQL = `count() AS SpanCount,
  sum(SampleRate) AS EstimatedSpanCount,
  countIf(StatusCode = 'Error') AS ErrorCount,
  sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
  sum(toFloat64(Duration)) AS DurationSum,
  quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,`

const MINUTELY_APDEX_SQL = `countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,
  countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount`

const MINUTELY_COLUMNS = [
	"OrgId",
	"Minute",
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
] as const

const MINUTELY_GROUP_BY = "OrgId, Minute, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha"

/**
 * Backfill for the 30 days still present in the `service_overview_spans`
 * projection — the same source and window migration 0009 used for the hourly
 * rollup, and for the same reason: the projection is already filtered to the
 * entry-point predicate, so the backfill's semantics match the MV's by
 * construction rather than by a re-typed `WHERE`. Raw `traces` offers no deeper
 * window; both are retained 30 days.
 *
 * Runs before the live MV is attached, so retained rows and future insert blocks
 * cannot double-count. Day-aligned chunks are coarser than the minute groups
 * below, so no group straddles a chunk boundary.
 */
export const serviceOverviewMinutelyBackfill: BackfillSpec = {
	kind: "backfill",
	target: "service_overview_minutely",
	columns: [...MINUTELY_COLUMNS],
	from: "service_overview_spans",
	tsColumn: "Timestamp",
	select: `OrgId,
  toStartOfMinute(Timestamp) AS Minute,
  ServiceName,
  DeploymentEnv,
  ServiceNamespace,
  CommitSha,
  ${MINUTELY_AGGREGATE_SQL}
  min(Timestamp) AS FirstSeen,
  ${MINUTELY_APDEX_SQL}`,
	groupBy: MINUTELY_GROUP_BY,
}

/**
 * Minute-grain service-overview rollup.
 *
 * Read-path only — `requiredForIngest: false` is load-bearing. Bumping the
 * ingest-gating schema version would un-ready direct ingest for every
 * BYO-ClickHouse org until an admin re-applied the schema, for a table the
 * ingest path never writes to.
 *
 * The MV reads `traces` rather than being cascaded from
 * `service_overview_hourly_mv`. See the comment on `serviceOverviewMinutelyMv`
 * in `packages/domain/src/tinybird/materializations.ts` — a cascade makes this
 * backfill double-count into the one table that cannot be rebuilt.
 */
export const migration_0015_service_overview_minutely = {
	version: 15,
	description: "Add minutely service overview rollup for sub-hour bucket windows",
	requiredForIngest: false,
	statements: [
		// DROP → CREATE → TRUNCATE → backfill → CREATE MV. The truncate is what
		// makes a re-apply converge instead of doubling; it is safe only because
		// the view is detached first, so nothing is writing at that moment.
		"DROP VIEW IF EXISTS service_overview_minutely_mv",
		`CREATE TABLE IF NOT EXISTS service_overview_minutely (
  OrgId LowCardinality(String),
  Minute DateTime,
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
PARTITION BY toDate(Minute)
ORDER BY (OrgId, ServiceName, Minute, DeploymentEnv, ServiceNamespace, CommitSha)
TTL toDate(Minute) + INTERVAL 90 DAY`,
		"TRUNCATE TABLE IF EXISTS service_overview_minutely",
		serviceOverviewMinutelyBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_minutely_mv TO service_overview_minutely AS
SELECT
  OrgId,
  toStartOfMinute(toDateTime(Timestamp)) AS Minute,
  ServiceName,
  ResourceAttributes['deployment.environment'] AS DeploymentEnv,
  ResourceAttributes['service.namespace'] AS ServiceNamespace,
  ResourceAttributes['deployment.commit_sha'] AS CommitSha,
  ${MINUTELY_AGGREGATE_SQL}
  min(toDateTime(Timestamp)) AS FirstSeen,
  ${MINUTELY_APDEX_SQL}
FROM traces
WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
GROUP BY ${MINUTELY_GROUP_BY}`,
	],
} as const
