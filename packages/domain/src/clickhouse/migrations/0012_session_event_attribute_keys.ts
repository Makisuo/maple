/**
 * Migration 0012 — plain String keys for `session_events.Attributes`.
 *
 * `Attributes` was declared `Map(LowCardinality(String), String)` back when the
 * only writer was the SDK itself, with a fixed handful of keys (`error`, and
 * friends) — a shared dictionary is exactly right for that.
 *
 * `track(name, props)` changes the premise: the keys are now whatever the
 * customer's app calls them, up to 32 per event, and an integration that writes
 * one unique key per event (`order_1234`) churns the LowCardinality dictionary
 * for every part of the table. That is the same reasoning that made
 * `session_replays.UserTraits` a plain `Map(String, String)` when it landed one
 * migration ago; this brings the older column in line before the first
 * customer-controlled keys are written to it.
 *
 * Unlike 0011's appends, `MODIFY COLUMN` is a **mutation**: ClickHouse rewrites
 * the column across existing parts rather than editing metadata. It is bounded
 * here — `session_events` carries a 30-day TTL — but it is real I/O on a live
 * cluster, so it is its own migration rather than a line in 0011.
 *
 * `requiredForIngest` is left at its default (true): the native INSERT writes
 * this column, and a cluster still holding the LowCardinality key type would
 * reject rows once the gateway stops normalizing keys.
 */
export const migration_0012_session_event_attribute_keys = {
	version: 12,
	description: "Widen session_events.Attributes keys from LowCardinality(String) to String",
	statements: ["ALTER TABLE session_events MODIFY COLUMN Attributes Map(String, String)"],
} as const
