/**
 * Reserved configuration name for the `service_ai_vendors_hourly` enablement
 * hour. v1 reserves the name and states the reader rule; nothing consumes it
 * yet, because the read path does not exist yet.
 *
 * ## Why a boundary is needed at all
 *
 * The rollup's materialized view is an insert trigger: it only ever sees spans
 * written after it was created. The hour in which it is created is therefore
 * **truncated but indistinguishable from a complete hour** — every span the
 * classifier examined was classified correctly, the counters are internally
 * consistent, `EligibleSpanCount` still equals the sum of the four state
 * counters, and nothing in the row says "this hour started before I existed".
 * A coverage ratio computed over it is not wrong so much as computed over an
 * arbitrary suffix of the hour.
 *
 * The design that would have made this self-marking — an all-traffic watermark
 * table whose version-0 rows exposed partial-classification windows — was
 * deliberately dropped: production classifies unconditionally, so partial
 * windows are migration-scoped rather than ongoing, and paying for a
 * second all-traffic MV to mark a one-time boundary was the wrong trade. This
 * config value is what replaced it.
 *
 * ## The reader rule
 *
 * Readers must treat every hour **strictly before** this value as nonexistent —
 * not as zero. "No AI spans this hour" and "the rollup was not recording this
 * hour" are different claims, and only the first one may be shown to a customer.
 * A query window that starts before the boundary is clamped forward to it, and
 * the UI says so rather than silently narrowing.
 *
 * A rollback and re-enable during the migration window produces a *new*
 * boundary; the hours between the two are unclassified and fall under the same
 * rule. Post-rollout there is no flag, so the boundary never moves again.
 *
 * ## Format
 *
 * An ISO-8601 UTC hour with no sub-hour component — `2026-08-12T00:00:00Z` —
 * naming the first hour the rollup covers in full. It is set by the deployment
 * that creates the MV (ClickHouse migration 0016), to the first hour boundary
 * strictly after MV creation.
 */
export const AI_VENDORS_ROLLUP_ENABLEMENT_HOUR_ENV = "AI_VENDORS_ROLLUP_ENABLEMENT_HOUR" as const

/**
 * Name of the rollup the boundary above governs. Kept beside it so a grep for
 * either one finds the other.
 */
export const AI_VENDORS_ROLLUP_TABLE = "service_ai_vendors_hourly" as const
