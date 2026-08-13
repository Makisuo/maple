import { SERVICE_AI_VENDORS_HOURLY_SELECT_SQL } from "../../tinybird/ai-vendors-rollup-sql"

/**
 * Migration 0017 — the AI vendor discovery rollup and its live-write MV.
 *
 * Installs the empty target and the view that fills it forward. Deliberately no
 * `POPULATE` and no backfill spec: unlike 0008/0014 there is nothing safe to
 * backfill here, because correctness depends on the *source rows* having been
 * classified, not on the view having existed.
 *
 * ## !! OPERATOR STEP — nothing in this file enforces it !!
 *
 * **This migration does not gate on the classification flag, and cannot.** It
 * sits in the same chain as 0015 and is applied in the same `applySchema` pass,
 * while `INGEST_AI_CLASSIFICATION_ENABLED` defaults to `false` and ramps later.
 * So in practice the MV exists *before* the ramp, not after it, and the ordering
 * the write-side plan's §7 step 3 asks for is inverted by construction. Do not
 * read the paragraph below as something CI or the runner checks — it is a step a
 * human performs, and the only thing that makes it real is doing it.
 *
 * The consequence to avoid: the hour in which the flag reaches 100% is
 * *partially* classified, and nothing in the row says so. `EligibleSpanCount`
 * still equals the four state counters, `RowRulesVersionMin/Max` are both the
 * live version for the rows that made it in, and a coverage ratio computed over
 * that hour renders as a real number. (The watermark table that would have made
 * such hours self-marking was deliberately dropped — see `../../ai`'s
 * `rollup-enablement.ts` for why.)
 *
 * **The step, in order:**
 *
 * 1. Apply this migration (any time — the MV starts accreting whatever is
 *    classified, which before the ramp is nothing, since `WHERE AiVendor != ''`
 *    matches no unclassified row).
 * 2. Ramp `INGEST_AI_CLASSIFICATION_ENABLED` to 100% across the whole fleet.
 * 3. Note the wall-clock time the ramp completed. Set
 *    `AI_VENDORS_ROLLUP_ENABLEMENT_HOUR` (see `../../ai`) to the **first hour
 *    boundary strictly after that time**. That hour — not MV creation — is the
 *    first hour the rollup covers in full.
 * 4. Only then may any reader show a number from this table.
 *
 * Rollback is migration-window-only (production has no flag): flag off ⇒ spans
 * arrive with `AiVendor = ''`, `AiRulesVersion = 0`, and the rollup simply stops
 * accreting because the MV's `WHERE` no longer matches. Re-enabling repeats
 * steps 2–3 and records a *fresh* boundary; readers treat the hours between the
 * two boundaries as unclassified.
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
