import type { BackfillSpec } from "../backfill"

/**
 * The projection shared byte-for-byte between the live-write materialized view
 * and {@link webEventsBackfill}. Two copies of this SELECT is two chances for a
 * backfilled row and a live row of the same event to disagree, which on a table
 * with no dedup surfaces as a page-view count that shifts at the backfill
 * boundary.
 */
const WEB_EVENTS_PROJECTION_SQL = `OrgId,
  Timestamp,
  SessionId,
  Seq,
  Type AS Kind,
  if(Type = 'navigation', '$pageview', Message) AS EventName,
  domain(Url) AS Host,
  path(Url) AS PagePath,
  Url,
  Attributes`

const WEB_EVENTS_SOURCE_FILTER = "Type IN ('navigation', 'custom')"

/**
 * Backfill for {@link migration_0014_web_events}, run as part of the migration
 * rather than as a separate operator step.
 *
 * Row-wise, so unlike the aggregate backfills any chunk boundary is safe — no
 * group can straddle one. `prefer_column_name_to_alias = 1` (added by
 * `buildInsert` on chunked runs) keeps the windowing predicate bound to the
 * source `Timestamp` rather than to a projection alias.
 *
 * **`web_events` is a plain MergeTree with no dedup**, so a backfill overlapping
 * the period the materialized view has been writing double-counts every page
 * view in the overlap. The statement order below makes that impossible rather
 * than merely unlikely: the view is dropped first, the target truncated, the
 * backfill run, and only then is the view created. At no point are two writers
 * pointed at this table.
 *
 * The residual is a gap, not a duplicate — `session_events` rows inserted while
 * the backfill is running are missed, since the view does not exist yet to catch
 * them. That is bounded by the backfill's own runtime (day-aligned chunks over
 * at most the source's 30-day TTL), it under-counts rather than over-counts, and
 * it ages out of the window on its own. A duplicate would do none of those
 * things, which is why the order is this way round and not the other.
 */
export const webEventsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "web_events",
	columns: [
		"OrgId",
		"Timestamp",
		"SessionId",
		"Seq",
		"Kind",
		"EventName",
		"Host",
		"PagePath",
		"Url",
		"Attributes",
	],
	from: "session_events",
	tsColumn: "Timestamp",
	select: WEB_EVENTS_PROJECTION_SQL,
	where: WEB_EVENTS_SOURCE_FILTER,
}

/**
 * Migration 0014 — the web analytics fact table.
 *
 * Installs the target, backfills it from `session_events`, then attaches the
 * live-write view. There is no feature flag: the read path switches to this
 * table as soon as it exists, so the table has to arrive populated. A
 * materialized view only ever sees rows inserted after it is created, and an
 * empty table is not an error any fallback can detect — it just renders as zero
 * page views.
 *
 * Re-runnable by construction. `DROP VIEW` + `TRUNCATE` before the backfill mean
 * a retried or re-applied migration converges to the same rows instead of
 * doubling them; both are safe because the view does not exist at that point, so
 * nothing is being written that the truncate could destroy.
 *
 * **This covers BYO ClickHouse only.** Managed orgs are on Tinybird, which does
 * not run these migrations — `web_events_mv` arrives there via `tinybird deploy`
 * from `materializations.ts`, and the Tinybird SDK has no populate option
 * (`MaterializedViewOptions` is description/nodes/datasource/deploymentMethod/
 * tokens). Populating it is an explicit `tb` step at deploy time, subject to the
 * backfill ceiling in `docs/persistence.md` — you can only recover what
 * `session_events` still retains. Managed is the common path, so skipping that
 * step is the more likely way for this to ship broken.
 *
 * `requiredForIngest: false`: this touches no ingest path — nothing writes
 * `web_events` directly — so it must not bump `clickHouseSchemaVersion`, which
 * would un-ready every BYO-ClickHouse org's ingest routing until they re-applied
 * schema. Same reasoning as migration 0010.
 */
export const migration_0014_web_events = {
	version: 14,
	description: "Add the web analytics fact table, backfill it, and attach its materialized view",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS web_events_mv",
		`CREATE TABLE IF NOT EXISTS web_events (
  OrgId LowCardinality(String),
  Timestamp DateTime64(9),
  SessionId String,
  Seq UInt32,
  Kind LowCardinality(String),
  EventName String,
  Host LowCardinality(String),
  PagePath String,
  Url String,
  Attributes Map(String, String),
  INDEX idx_event_name EventName TYPE set(64) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, Timestamp, SessionId, Seq)
TTL toDate(Timestamp) + INTERVAL 30 DAY`,
		// Idempotency, and only safe here: the view is already dropped, so no
		// writer is pointed at this table and there is nothing live to lose.
		"TRUNCATE TABLE IF EXISTS web_events",
		webEventsBackfill,
		// Attached last. Everything before this point is single-writer; from here
		// the view is the only writer.
		`CREATE MATERIALIZED VIEW IF NOT EXISTS web_events_mv TO web_events AS
SELECT ${WEB_EVENTS_PROJECTION_SQL}
FROM session_events
WHERE ${WEB_EVENTS_SOURCE_FILTER}`,
	],
} as const
