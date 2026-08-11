import { SERVICE_AI_VENDORS_HOURLY_SELECT_SQL } from "../../tinybird/ai-vendors-rollup-sql"

/**
 * Migration 0016 — the AI vendor discovery rollup and its live-write MV.
 *
 * Installs the empty target and the view that fills it forward. Deliberately no
 * `POPULATE` and no backfill spec: unlike 0008/0014 there is nothing safe to
 * backfill here, because correctness depends on the *source rows* having been
 * classified, not on the view having existed.
 *
 * ## Deploy gate (runbook precondition, not code)
 *
 * The ingest classification flag must be at **100% for at least one full clock
 * hour** before this migration runs in production. The write-side plan's §8 gate
 * is hard, not a preference: the watermark table that would have made partially
 * classified hours self-marking was removed, so a partial hour is
 * indistinguishable from a complete one at read time. Rolling this out mid-ramp
 * produces an hour of rows that look healthy and undercount.
 *
 * Rollback is migration-window-only (production has no flag): flag off ⇒ spans
 * arrive with `AiVendor = ''`, `AiRulesVersion = 0`, and the rollup simply stops
 * accreting because the MV's `WHERE` no longer matches. Re-enabling records a
 * *fresh* enablement boundary; readers treat the hours between the two
 * boundaries as unclassified.
 *
 * ## Enablement hour
 *
 * The hour this view is created is truncated — the classifier saw every span,
 * but the view did not exist for part of the hour — and nothing about the stored
 * row distinguishes it from a complete hour. The deployment therefore records
 * the first fully covered hour in config
 * (`AI_VENDORS_ROLLUP_ENABLEMENT_HOUR_ENV`, see `../../ai-registry`) and readers
 * treat everything before it as nonexistent. v1 reserves the name and documents
 * the rule; no consumer reads it yet because no read path exists yet.
 *
 * ## Org deletion and retention
 *
 * `ALTER TABLE service_ai_vendors_hourly DELETE WHERE OrgId = '…'` is the one
 * sanctioned mutation on this table — well-pruned, since `OrgId` is the
 * sort-key prefix. It is the named exception to the no-mutation rule the rest of
 * the warehouse follows.
 *
 * Retention is deliberately asymmetric: 400 days here against `traces`' 30. The
 * rollup outlives the raw spans it was derived from, which is the point (a year
 * of vendor history costs a few thousand rows per org) and also the constraint —
 * past the raw horizon these rows cannot be rebuilt from anything, so a registry
 * fix can only repair partitions whose source spans still exist.
 *
 * `requiredForIngest: false`: the gateway's INSERT column list is untouched, so a
 * BYO cluster still at 15 keeps ingesting correctly and only misses a read-path
 * concern. `clickHouseSchemaVersion` stays "15" for exactly that reason —
 * un-readying every BYO org over a rollup they do not yet query would route their
 * ingest to managed Tinybird while the dashboard kept reading their cluster.
 *
 * The `CREATE MATERIALIZED VIEW` body is imported, not retyped: the deployed view
 * and the migrated view must be the same query, and the index test asserts it.
 */
export const migration_0016_service_ai_vendors_hourly = {
	version: 16,
	description: "Add the hourly AI vendor discovery rollup and its live-write materialized view",
	requiredForIngest: false,
	statements: [
		`CREATE TABLE IF NOT EXISTS service_ai_vendors_hourly (
  OrgId LowCardinality(String),
  ServiceName LowCardinality(String),
  AiVendor LowCardinality(String),
  Hour DateTime('UTC'),
  SpanCount SimpleAggregateFunction(sum, UInt64),
  WeightedSpanCount SimpleAggregateFunction(sum, Float64),
  EligibleSpanCount SimpleAggregateFunction(sum, UInt64),
  KeyAbsentCount SimpleAggregateFunction(sum, UInt64),
  KeyInvalidCount SimpleAggregateFunction(sum, UInt64),
  KeySubSessionCount SimpleAggregateFunction(sum, UInt64),
  KeySessionCount SimpleAggregateFunction(sum, UInt64),
  TracesTotal AggregateFunction(uniqCombined(12), String),
  TracesWithKey AggregateFunction(uniqCombined(12), String),
  SessionsApprox AggregateFunction(uniqCombined(12), UInt64),
  RowRulesVersionMin SimpleAggregateFunction(min, UInt32),
  RowRulesVersionMax SimpleAggregateFunction(max, UInt32),
  RollupRulesVersion SimpleAggregateFunction(max, UInt32)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(Hour)
ORDER BY (OrgId, ServiceName, AiVendor, Hour)
TTL Hour + INTERVAL 400 DAY`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_ai_vendors_hourly_mv TO service_ai_vendors_hourly AS
${SERVICE_AI_VENDORS_HOURLY_SELECT_SQL}`,
	],
} as const
