import { SERVICE_AI_VENDORS_HOURLY_SELECT_SQL } from "../../tinybird/ai-vendors-rollup-sql"

/**
 * Migration 0017 — the AI vendor discovery rollup and its live-write MV.
 *
 * Installs the empty target and the view that fills it forward. Deliberately no
 * `POPULATE` and no backfill spec: unlike 0008/0014 there is nothing safe to
 * backfill here, because correctness depends on the *source rows* having been
 * classified, not on the view having existed.
 *
 * ## Operator step — nothing in this file enforces it
 *
 * This migration cannot gate on the classifying gateway being live: it is
 * applied in the same `applySchema` pass as the rest of the chain, possibly
 * while pre-classification gateway binaries still serve traffic. So the MV can
 * exist *before* classified rows flow, and the hour the last old binary drains
 * is only partially classified while looking perfectly healthy — every counter
 * in it is internally consistent and nothing in the row says so.
 *
 * 1. Apply this migration (any time — under a pre-classification binary the MV
 *    is a no-op, since `WHERE AiVendor != ''` matches no unclassified row).
 * 2. Deploy the classifying gateway (ingest classifies unconditionally; there
 *    is no flag) across the whole fleet.
 * 3. Set `AI_VENDORS_ROLLUP_ENABLEMENT_HOUR` (see `../../ai`) to the **first hour
 *    boundary strictly after the rollout completed**. That hour — not MV
 *    creation — is the first hour the rollup covers in full.
 * 4. Only then may any reader show a number from this table.
 *
 * Rollback is migration-window-only: reverting to a pre-classification binary
 * means spans arrive with `AiVendor = ''` and the rollup stops accreting because
 * the MV's `WHERE` no longer matches. Rolling forward again repeats steps 2–3
 * and records a *fresh* boundary; readers treat the hours between the two as
 * unclassified.
 *
 * ## Org deletion and retention
 *
 * `ALTER TABLE service_ai_vendors_hourly DELETE WHERE OrgId = '…'` is the one
 * sanctioned mutation on this table — well-pruned, since `OrgId` is the sort-key
 * prefix.
 *
 * Retention is deliberately asymmetric: 400 days here against `traces`' 30. The
 * rollup outlives the raw spans it was derived from, which is the point and also
 * the constraint — past the raw horizon these rows cannot be rebuilt from
 * anything, so a registry fix can only repair partitions whose source spans still
 * exist.
 *
 * `requiredForIngest: false`, and the ingest gate is not bumped: the gateway's
 * INSERT column list is untouched, so un-readying every BYO org over a rollup
 * they do not yet query would route their ingest to managed Tinybird while the
 * dashboard kept reading their cluster.
 *
 * The `CREATE MATERIALIZED VIEW` body is imported, not retyped: the deployed view
 * and the migrated view must be the same query, and the index test asserts it.
 */
export const migration_0017_service_ai_vendors_hourly = {
	version: 17,
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
