/**
 * Migration 0013 — `session_replays.BillableStart`.
 *
 * Makes the browser-session invoice reproducible from the warehouse. Until now
 * nothing here recorded which sessions were charged: the ingest gateway metered
 * rows whose `Version` was 1, `Version` exists only so `argMax(field, Version)`
 * resolves the newest row of a ReplacingMergeTree, and the two facts never met
 * in the same table. "Why is this month's bill what it is" had no query.
 *
 * The billed unit is a *visit* — one visitor per 30-minute idle window, spanning
 * tabs and subdomains — not a `SessionId`, which is scoped to one tab and one
 * origin by sessionStorage. So `countIf(BillableStart = 1)` and
 * `uniq(SessionId)` are both correct and deliberately different numbers, and
 * only the first matches Autumn.
 *
 * Appended at the end of the table with a constant DEFAULT, so this is a
 * metadata-only `ALTER` on ClickHouse and Tinybird alike and existing parts read
 * the default for free — no `MATERIALIZE COLUMN`. That default also means rows
 * already in the table read as unbilled even where the gateway did bill them
 * under the old rule; the column is only truthful going forward, and the 30-day
 * TTL rolls the ambiguous window out on its own.
 *
 * `requiredForIngest` is left at its default (true): the native ClickHouse
 * INSERT names every column explicitly, so a BYO cluster that has not applied
 * this migration must not be routed direct ingest.
 */
export const migration_0013_session_billable_start = {
	version: 13,
	description: "Add BillableStart to session_replays so the browser-session bill is auditable",
	statements: ["ALTER TABLE session_replays ADD COLUMN IF NOT EXISTS BillableStart UInt8 DEFAULT 0"],
} as const
