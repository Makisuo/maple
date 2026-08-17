/**
 * Reserved configuration name for the `service_ai_vendors_hourly` enablement
 * hour. Nothing consumes it yet — the read path does not exist.
 *
 * The boundary is **the hour `INGEST_AI_CLASSIFICATION_ENABLED` reaches 100%
 * across the fleet**, not the hour the MV was created (before the ramp
 * `WHERE AiVendor != ''` matches nothing, so MV creation truncates an empty
 * hour). That hour is partly classified and **indistinguishable from a complete
 * one**: every counter in it is internally consistent, `EligibleSpanCount` still
 * equals the sum of the four state counters, and nothing in the row says most of
 * the hour never reached the classifier.
 *
 * Reader rule: every hour **strictly before** this value is nonexistent, not
 * zero. "No AI spans this hour" and "the rollup was not recording this hour" are
 * different claims and only the first may be shown to a customer — clamp a query
 * window forward to the boundary and say so rather than silently narrowing.
 *
 * Format: an ISO-8601 UTC hour with no sub-hour component,
 * `2026-08-12T00:00:00Z`, naming the first hour the rollup covers in full.
 * Nothing writes it automatically; it is an operator step in the cutover
 * runbook, spelled out in migration 0017's header. A rollback and re-enable
 * during the migration window records a *fresh* boundary, and the hours between
 * the two are unclassified and fall under the same rule. Post-rollout there is
 * no flag, so the boundary never moves again.
 */
export const AI_VENDORS_ROLLUP_ENABLEMENT_HOUR_ENV = "AI_VENDORS_ROLLUP_ENABLEMENT_HOUR" as const

/** Name of the rollup the boundary above governs. */
export const AI_VENDORS_ROLLUP_TABLE = "service_ai_vendors_hourly" as const
