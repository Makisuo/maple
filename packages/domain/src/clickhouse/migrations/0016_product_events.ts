import type { BackfillSpec } from "../backfill"

/**
 * The browser-row projection shared byte-for-byte between the live-write
 * materialized view and {@link productEventsBrowserBackfill}. Two copies of this
 * SELECT is two chances for a backfilled row and a live row of the same event to
 * disagree, which on a table with no dedup surfaces as a page-view count that
 * shifts at the backfill boundary.
 */
const PRODUCT_EVENTS_PROJECTION_SQL = `OrgId,
  Timestamp,
  'browser' AS Source,
  SessionId,
  Seq,
  VisitorId,
  UserId,
  GroupId,
  Type AS Kind,
  if(Type = 'navigation', '$pageview', Message) AS EventName,
  domain(Url) AS Host,
  path(Url) AS PagePath,
  Url,
  '' AS ServiceName,
  Attributes`

const PRODUCT_EVENTS_SOURCE_FILTER = "Type IN ('navigation', 'custom')"

/**
 * Browser-row backfill for {@link migration_0016_product_events}.
 *
 * Row-wise, so any chunk boundary is safe. Unlike 0014's `web_events`, the
 * target is **dual-fed**: `POST /v1/events` writes server/mobile rows directly,
 * with no source table to rebuild them from. So the idempotency step is not
 * `TRUNCATE` but `DELETE WHERE Source = 'browser'` — the view is dropped first,
 * only browser rows are cleared, the backfill runs, then the view is re-created.
 * At no point are two writers of *browser* rows pointed at this table, and at no
 * point can a directly ingested row be lost.
 */
export const productEventsBrowserBackfill: BackfillSpec = {
	kind: "backfill",
	target: "product_events",
	columns: [
		"OrgId",
		"Timestamp",
		"Source",
		"SessionId",
		"Seq",
		"VisitorId",
		"UserId",
		"GroupId",
		"Kind",
		"EventName",
		"Host",
		"PagePath",
		"Url",
		"ServiceName",
		"Attributes",
	],
	from: "session_events",
	tsColumn: "Timestamp",
	select: PRODUCT_EVENTS_PROJECTION_SQL,
	where: PRODUCT_EVENTS_SOURCE_FILTER,
}

/**
 * Migration 0016 — product events: `web_events` becomes `product_events`.
 *
 * Three things, in order:
 *
 * 1. `session_events` gains `VisitorId`/`UserId`/`GroupId` (all `DEFAULT ''`),
 *    stamped per event by the SDK. Metadata-only `ADD COLUMN`s, like 0011.
 * 2. `product_events` replaces `web_events`: same time-first fact table, plus
 *    `Source` (`browser`/`server`/`mobile`), the person key, `ServiceName`, and
 *    a 365-day TTL. Backends and mobile apps write it directly via
 *    `POST /v1/events`; browser rows arrive through `product_events_mv`. The
 *    browser half is backfilled from `session_events` (its 30-day window is all
 *    there is), and `web_events` + its view are dropped — every reader moved to
 *    the new table in the same release, and the old one cannot be rebuilt past
 *    what the new one now holds.
 * 3. `identity_links` — (VisitorId, UserId) pairs out of `session_replays`,
 *    the stitch between a person's anonymous marketing visit and their
 *    identified/server-side events. Backfilled from `session_replays` for the
 *    same 30-day reason.
 *
 * Re-runnable by construction: views are dropped first, `product_events`
 * clears only `Source = 'browser'` (never a directly ingested row), and
 * `identity_links` is a ReplacingMergeTree so a re-insert of a pair is a no-op.
 *
 * **BYO ClickHouse only.** Managed orgs get `product_events_mv` /
 * `identity_links_mv` via `tinybird deploy` from `materializations.ts`, and the
 * populate is an explicit `tb` step at deploy time (see 0014's note; the SDK has
 * no populate option).
 *
 * `requiredForIngest` stays at its default (true) this time: the ingest gateway
 * writes `session_events` with the three new columns and `product_events`
 * directly, and a cluster without them rejects those rows.
 */
export const migration_0016_product_events = {
	version: 16,
	description:
		"Add identity columns to session_events; replace web_events with the dual-fed product_events table and add identity_links",
	statements: [
		"ALTER TABLE session_events ADD COLUMN IF NOT EXISTS VisitorId String DEFAULT ''",
		"ALTER TABLE session_events ADD COLUMN IF NOT EXISTS UserId String DEFAULT ''",
		"ALTER TABLE session_events ADD COLUMN IF NOT EXISTS GroupId String DEFAULT ''",
		"DROP VIEW IF EXISTS product_events_mv",
		"DROP VIEW IF EXISTS identity_links_mv",
		`CREATE TABLE IF NOT EXISTS product_events (
  OrgId LowCardinality(String),
  Timestamp DateTime64(9),
  Source LowCardinality(String) DEFAULT 'browser',
  SessionId String DEFAULT '',
  Seq UInt32 DEFAULT 0,
  VisitorId String DEFAULT '',
  UserId String DEFAULT '',
  GroupId String DEFAULT '',
  Kind LowCardinality(String),
  EventName String,
  Host LowCardinality(String) DEFAULT '',
  PagePath String DEFAULT '',
  Url String DEFAULT '',
  ServiceName LowCardinality(String) DEFAULT '',
  Attributes Map(String, String) DEFAULT map(),
  INDEX idx_event_name EventName TYPE set(64) GRANULARITY 4,
  INDEX idx_user_id UserId TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, Timestamp, VisitorId, SessionId, Seq)
TTL toDate(Timestamp) + INTERVAL 365 DAY`,
		`CREATE TABLE IF NOT EXISTS identity_links (
  OrgId LowCardinality(String),
  VisitorId String,
  UserId String,
  FirstSeen DateTime64(9)
)
ENGINE = ReplacingMergeTree
PARTITION BY tuple()
ORDER BY (OrgId, VisitorId, UserId)
TTL toDate(FirstSeen) + INTERVAL 365 DAY`,
		// Idempotency for the browser half only — a directly ingested row has no
		// source to come back from. Lightweight delete; the view is already
		// dropped, so nothing is writing browser rows while this runs.
		"DELETE FROM product_events WHERE Source = 'browser'",
		productEventsBrowserBackfill,
		{
			kind: "backfill",
			target: "identity_links",
			columns: ["OrgId", "VisitorId", "UserId", "FirstSeen"],
			from: "session_replays",
			tsColumn: "StartTime",
			select: "OrgId, VisitorId, UserId, StartTime AS FirstSeen",
			where: "VisitorId != '' AND UserId != ''",
		} satisfies BackfillSpec,
		// Views attached last; from here they are the only browser-row writers.
		`CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_mv TO product_events AS
SELECT ${PRODUCT_EVENTS_PROJECTION_SQL}
FROM session_events
WHERE ${PRODUCT_EVENTS_SOURCE_FILTER}`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS identity_links_mv TO identity_links AS
SELECT OrgId, VisitorId, UserId, StartTime AS FirstSeen
FROM session_replays
WHERE VisitorId != '' AND UserId != ''`,
		// The old table last, once the new one is populated and its writer live.
		"DROP VIEW IF EXISTS web_events_mv",
		"DROP TABLE IF EXISTS web_events",
	],
} as const
