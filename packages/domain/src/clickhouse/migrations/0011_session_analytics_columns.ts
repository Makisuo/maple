/**
 * Migration 0011 — session analytics columns.
 *
 * Extends `session_replays` from "enough to list and replay a session" to
 * "enough to answer web-analytics questions": who the visitor is (persistent
 * VisitorId, identity, group/company), where they came from (referrer, UTM),
 * and what they landed on / left from (host, entry + exit path). Plus
 * LastActivityAt, which is what makes duration and bounce rate computable for
 * sessions killed without an unload beacon.
 *
 * Every column is appended at the end of the table and carries a DEFAULT —
 * except `LastActivityAt`, which is Nullable and therefore defaults to NULL,
 * the value that actually distinguishes "an older SDK never sent this" from
 * "the session was last seen at epoch 0". Both properties are load-bearing: a
 * defaulted trailing column is a metadata-only `ALTER` on ClickHouse and
 * Tinybird alike, and the default is what keeps an older SDK's rows (which send
 * none of these keys) out of quarantine. No `MATERIALIZE COLUMN` is needed —
 * the defaults are constants, so existing parts read them for free.
 *
 * `requiredForIngest` is left at its default (true): the native ClickHouse
 * INSERT names every column explicitly, so a BYO cluster that has not applied
 * this migration must not be routed direct ingest.
 *
 * The session_events index supports the "top custom events" query that lands
 * with the /analytics page — `Type` is not in the sorting key
 * (OrgId, SessionId, Timestamp, Seq), so filtering by it would otherwise scan
 * every session's whole transcript. It is declared on the datasource as well,
 * which is what puts it on managed (Tinybird) orgs and on freshly bootstrapped
 * clusters; this statement is what backfills clusters already at version 10.
 * Deliberately no `MATERIALIZE INDEX`: that is a mutation over the whole table,
 * and the 30-day TTL rolls every unindexed part out on its own.
 */
export const migration_0011_session_analytics_columns = {
	version: 11,
	description:
		"Add visitor/identity/acquisition/page columns to session_replays and a Type skip index to session_events",
	statements: [
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS VisitorId String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS VisitorIsNew UInt8 DEFAULT 0",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UserEmail String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UserName String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS GroupId String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS GroupName String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UserTraits Map(String, String) DEFAULT map()",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS Referrer String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS ReferrerHost LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UtmSource LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UtmMedium LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UtmCampaign LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UtmTerm String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS UtmContent String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS Host LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS EntryPath String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS ExitPath String DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS Language LowCardinality(String) DEFAULT ''",
		"ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS LastActivityAt Nullable(DateTime64(9))",
		"ALTER TABLE session_events ADD INDEX IF NOT EXISTS idx_type Type TYPE set(16) GRANULARITY 4",
	],
} as const
