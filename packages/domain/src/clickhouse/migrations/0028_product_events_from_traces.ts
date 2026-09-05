import type { BackfillSpec } from "../backfill"

/**
 * Frozen copy of the trace→product-event projection as of this migration.
 *
 * NOT imported from `tinybird/product-event-attributes.ts`, deliberately, and
 * for the reason migration 0019 spells out: a delta migration describes one step
 * in history. A shared constant would silently rewrite what this migration did
 * the next time the live projection changes, and a BYO cluster replaying the
 * chain would land somewhere the chain never says it goes.
 *
 * Shared *within* this file between the materialized view and the backfill,
 * which is the 0021 pattern — two copies of one SELECT is two chances for a
 * backfilled span and a live span to disagree.
 */
const PRODUCT_EVENTS_TRACE_PROJECTION_SQL = `OrgId,
  Timestamp,
  'trace' AS Source,
  SpanAttributes['session.id'] AS SessionId,
  0 AS Seq,
  SpanAttributes['maple.product_event.visitor_id'] AS VisitorId,
  SpanAttributes['maple.product_event.user_id'] AS UserId,
  SpanAttributes['maple.product_event.group_id'] AS GroupId,
  'custom' AS Kind,
  SpanAttributes['maple.product_event.name'] AS EventName,
  domain(SpanAttributes['maple.product_event.url']) AS Host,
  path(SpanAttributes['maple.product_event.url']) AS PagePath,
  SpanAttributes['maple.product_event.url'] AS Url,
  ServiceName,
  mapUpdate(
    CAST(
      mapFilter(
        (k, v) -> NOT startsWith(k, 'maple.product_event.')
          AND (
            NOT has(mapKeys(SpanAttributes), 'maple.product_event.include')
            OR has(
              arrayMap(
                key -> trimBoth(key),
                splitByChar(',', SpanAttributes['maple.product_event.include'])
              ),
              k
            )
          ),
        SpanAttributes
      ),
      'Map(String, String)'
    ),
    mapApply(
      (k, v) -> (substring(k, 26), v),
      mapFilter((k, v) -> startsWith(k, 'maple.product_event.prop.'), SpanAttributes)
    )
  ) AS Attributes,
  TraceId,
  SpanId`

const PRODUCT_EVENTS_TRACE_FILTER = "SpanAttributes['maple.product_event.name'] != ''"

/**
 * Backfill of the trace half of {@link migration_0028_product_events_from_traces}.
 *
 * Row-wise, so any chunk boundary is safe. Idempotent by `DELETE WHERE Source =
 * 'trace'` before it runs — same shape as 0021's browser half, and safe for the
 * same reason: it clears only rows this projection owns, never a browser row
 * from the other view or a directly ingested one that has no source to come back
 * from.
 *
 * Bounded by `traces`' own 30-day TTL, which is all there is to rebuild from.
 * `product_events` keeps 365 days, so an org that annotates spans today sees
 * ~30 days of history immediately and accrues the rest going forward.
 */
export const productEventsTracesBackfill: BackfillSpec = {
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
		"TraceId",
		"SpanId",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: PRODUCT_EVENTS_TRACE_PROJECTION_SQL,
	where: PRODUCT_EVENTS_TRACE_FILTER,
}

/**
 * Migration 0028 — product events annotated in code.
 *
 * A customer marks a span they already emit:
 *
 * ```
 * span.setAttributes({ "maple.product_event.name": "checkout_completed" })
 * ```
 *
 * and it becomes a row in `product_events` that a funnel steps on, carrying the
 * `TraceId` it came from. The annotation is instrumentation, not a UI action and
 * not a second store: the span remains the record and the product event is its
 * projection, so it applies to every trace the annotated code path produces
 * rather than to the one trace someone happened to be looking at.
 *
 * Two things, in order:
 *
 * 1. `product_events` gains `TraceId`/`SpanId` (`DEFAULT ''`) plus a bloom
 *    filter on `TraceId`. Metadata-only `ADD COLUMN`s, appended, which is why
 *    they sit last in the schema and last in every projection.
 * 2. `product_events_traces_mv` projects annotated spans in, and the trace half
 *    is backfilled from `traces`' 30-day window.
 *
 * `product_events_mv` is dropped and re-created rather than left alone: an MV's
 * SELECT is fixed at creation, so the pre-0028 body writes 15 columns into a
 * 17-column table and every browser row inserted between the ALTER and the
 * re-create would take defaults for the two new columns. They default to `''`,
 * which is the correct value for a browser row — so this is ordering hygiene
 * rather than a repair, and the re-create is what keeps the view's text and the
 * table's schema describing the same thing.
 *
 * Re-runnable by construction: `ADD COLUMN IF NOT EXISTS`, `ADD INDEX IF NOT
 * EXISTS`, and a `DELETE` scoped to the backfill's own source window so it
 * clears exactly and only what the following backfill re-inserts — at any point
 * in the table's life, not just on first apply.
 *
 * **BYO ClickHouse only.** Managed orgs get the same view via `tinybird deploy`
 * from `materializations.ts`, with the populate as an explicit `tb` step at
 * deploy time (see 0014 and 0021 — the SDK has no populate option).
 *
 * `requiredForIngest: false`, and that rests on ONE fact worth stating plainly
 * because it is not local to this file: `TraceId`/`SpanId` are declared in
 * `datasources.ts` WITHOUT a `jsonPath`, so
 * `scripts/generate-clickhouse-insert-mappings.ts` omits them and the Rust
 * gateway's `INSERT INTO product_events (…)` never names them. A cluster stamped
 * below 24 therefore still accepts every row the gateway sends.
 *
 * Give those columns a `jsonPath` and this flag becomes a data-loss bug: the
 * readiness gate compares `stamped >= clickHouseSchemaVersion`, which stays at
 * 21, so a BYO org that has not applied 0028 is still routed to its own cluster
 * — where the INSERT fails on the unknown column, retries, trips the breaker and
 * drops the batch. The gate's safety argument is "an older binary writing into a
 * newer schema", and that would be the inverse.
 *
 * Bumping `clickHouseSchemaVersion` instead would un-ready ingest routing for
 * every BYO-CH org over a feature none of their existing writers touch, which is
 * why the column declaration is the right place to solve it.
 */
export const migration_0028_product_events_from_traces = {
	version: 28,
	description:
		"Add TraceId/SpanId to product_events and materialize product events from spans carrying the maple.product_event.name attribute",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE product_events ADD COLUMN IF NOT EXISTS TraceId String DEFAULT ''",
		"ALTER TABLE product_events ADD COLUMN IF NOT EXISTS SpanId String DEFAULT ''",
		"ALTER TABLE product_events ADD INDEX IF NOT EXISTS idx_trace_id TraceId TYPE bloom_filter GRANULARITY 4",
		// The browser view is dropped and IMMEDIATELY recreated, before anything
		// slow runs. 0021 bracketed its backfill with the drop because there the
		// backfill WAS the browser feed and two writers of the same rows had to be
		// impossible. Here the backfill reads `traces` and the browser view reads
		// `session_events`, so the bracket buys nothing and costs everything: the
		// backfill is chunked across up to 400 durable workflow steps over 30 days
		// of spans, and every `session_events` navigation row ingested while the
		// view is gone is never projected at all. That is a permanent hole in page
		// views, not the "ordering hygiene" an earlier draft of this comment
		// called it. Recreated here, the outage is one statement wide.
		"DROP VIEW IF EXISTS product_events_mv",
		// Frozen copy of the browser projection as of 0021, plus the two new
		// columns explicitly at `''`. Same freezing rule as above: this is what
		// the view's body was at this point in history.
		`CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_mv TO product_events AS
SELECT
  OrgId,
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
  Attributes,
  '' AS TraceId,
  '' AS SpanId
FROM session_events
WHERE Type IN ('navigation', 'custom')`,
		"DROP VIEW IF EXISTS product_events_traces_mv",
		// Idempotency for the trace half only — never a browser row, never a
		// directly ingested one.
		//
		// BOUNDED BY THE BACKFILL'S OWN WINDOW, which is what makes the claim
		// above true on a LATE re-run rather than only on first apply. `traces`
		// keeps 30 days and `product_events` keeps 365, so by day 100 the table
		// holds trace rows the backfill can no longer rebuild. An unbounded
		// `DELETE WHERE Source = 'trace'` would clear all 100 days and re-insert
		// 30 — silently destroying 70 days of a customer's funnel history on a
		// re-apply after a lost bookkeeping row. Scoping the delete to
		// `min(Timestamp)` of the source means it removes exactly the rows the
		// following backfill is about to write, and nothing older.
		"DELETE FROM product_events WHERE Source = 'trace' AND Timestamp >= (SELECT min(Timestamp) FROM traces)",
		productEventsTracesBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_traces_mv TO product_events AS
SELECT
${PRODUCT_EVENTS_TRACE_PROJECTION_SQL}
FROM traces
WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
	],
} as const
