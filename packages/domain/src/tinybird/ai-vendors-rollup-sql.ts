/**
 * The single definition of the `service_ai_vendors_hourly` rollup SELECT, shared
 * by the materialized view (`serviceAiVendorsHourlyMv`) and ClickHouse migration
 * 0017, which creates the same view on an already-deployed cluster. Two copies
 * would be two chances for the deployed MV and the migrated one to disagree
 * about what a coverage ratio means; the migration index test asserts they stay
 * byte-identical.
 *
 * ClickHouse writes an MV's output into its target **by name**, so every alias
 * here must equal a target column name. An alias with no matching column raises
 * THERE_IS_NO_COLUMN, and because the view runs synchronously inside the INSERT
 * pipeline that hard-fails every INSERT into `traces` — rename a target column
 * and you must rename the alias in the same deploy. Matching column *order* is
 * only a readability convention.
 */
export const SERVICE_AI_VENDORS_HOURLY_SELECT_SQL = `SELECT
  OrgId,
  ServiceName,
  AiVendor,
  toStartOfHour(toDateTime(Timestamp)) AS Hour,
  count() AS SpanCount,
  sum(if(SampleRate > 0, SampleRate, 1.0)) AS WeightedSpanCount,
  countIf(AiSessionKeyState >= 3) AS EligibleSpanCount,
  countIf(AiSessionKeyState = 3) AS KeyAbsentCount,
  countIf(AiSessionKeyState = 4) AS KeyInvalidCount,
  countIf(AiSessionKeyState = 5) AS KeySubSessionCount,
  countIf(AiSessionKeyState = 6) AS KeySessionCount,
  uniqCombinedState(12)(TraceId) AS TracesTotal,
  uniqCombinedStateIf(12)(TraceId, AiSessionKeyState = 6) AS TracesWithKey,
  uniqCombinedStateIf(12)(AiSessionKeyHash, AiSessionKeyState = 6) AS SessionsApprox,
  min(AiRulesVersion) AS RowRulesVersionMin,
  max(AiRulesVersion) AS RowRulesVersionMax,
  max(AiRulesVersion) AS RollupRulesVersion
FROM traces
WHERE AiVendor != ''
GROUP BY OrgId, ServiceName, AiVendor, Hour`
