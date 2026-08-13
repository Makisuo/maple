/**
 * Reserved configuration name for the `service_ai_vendors_hourly` enablement
 * hour. v1 reserves the name and states the reader rule; nothing consumes it
 * yet, because the read path does not exist yet.
 *
 * ## Why a boundary is needed at all
 *
 * Two truncations, and the second is the one that actually bites. The rollup's
 * materialized view is an insert trigger, so it only sees spans written after it
 * was created — but the MV is created by migration 0017, which ships in the same
 * chain as 0016 and is applied while `INGEST_AI_CLASSIFICATION_ENABLED` is still
 * `false`. Before the ramp, `WHERE AiVendor != ''` matches nothing, so MV
 * creation truncates an empty hour and costs nothing.
 *
 * The real boundary is **the hour in which the classification flag reaches 100%
 * across the fleet**, which is a later hour that no code observes. That hour is
 * partly classified and partly not, and it is **indistinguishable from a
 * complete hour**: every span the classifier examined was classified correctly,
 * the counters are internally consistent, `EligibleSpanCount` still equals the
 * sum of the four state counters, and nothing in the row says "two thirds of
 * this hour never reached me". A coverage ratio computed over it is not wrong so
 * much as computed over an arbitrary suffix of the hour.
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
 * naming the first hour the rollup covers in full: the first hour boundary
 * **strictly after the classification flag reached 100% across the fleet**, not
 * after MV creation.
 *
 * Nothing writes it automatically. It is an operator step in the cutover
 * runbook, spelled out in migration 0017's header, and this constant exists so
 * the name that step sets and the name the first reader reads are the same
 * string. Until a reader exists there is nothing to enforce it against — which
 * is exactly why the step is written down loudly in two places rather than
 * implied by one.
 */
export const AI_VENDORS_ROLLUP_ENABLEMENT_HOUR_ENV = "AI_VENDORS_ROLLUP_ENABLEMENT_HOUR" as const

/**
 * Name of the rollup the boundary above governs. Kept beside it so a grep for
 * either one finds the other.
 */
export const AI_VENDORS_ROLLUP_TABLE = "service_ai_vendors_hourly" as const
