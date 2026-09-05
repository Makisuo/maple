import type { BackfillSpec } from "../backfill"

// Frozen copy of the trace→product-event projection as of this migration (the
// live one is `tinybird/product-event-attributes.ts`). Deliberately not imported:
// a delta migration describes one step in history. Shared within this file so
// the backfill and the view project a span identically.
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
 * Backfill of the trace half. Row-wise, so any chunk boundary is safe, and
 * bounded by `traces`' 30-day TTL against `product_events`' 365: an org sees
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
 * Migration 0028 — product events annotated in code. A span carrying
 * `maple.product_event.name` becomes a `product_events` row with its `TraceId`,
 * so it steps in a funnel and links back to the trace that produced it.
 *
 * 1. `product_events` gains `TraceId`/`SpanId` (`DEFAULT ''`, appended) plus a
 *    bloom filter on `TraceId`.
 * 2. `product_events_traces_mv` projects annotated spans in; the trace half is
 *    backfilled from `traces`' 30-day window.
 *
 * `product_events_mv` is recreated so its SELECT names all 17 columns.
 * Re-runnable: `IF NOT EXISTS` throughout and a `DELETE` scoped to the
 * backfill's own window.
 *
 * **BYO ClickHouse only.** Managed orgs get the view via `tinybird deploy`, with
 * the populate as an explicit `tb` step (see 0014 and 0021).
 *
 * `requiredForIngest: false` rests on `TraceId`/`SpanId` having NO `jsonPath` in
 * `datasources.ts`: the insert-mapping generator omits them, so the gateway's
 * `INSERT INTO product_events (…)` never names them and a cluster stamped below
 * 28 still accepts every row. Give them a path and unmigrated BYO orgs drop every
 * `/v1/events` batch on the unknown column.
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
		// Dropped and IMMEDIATELY recreated: every `session_events` row ingested
		// while the browser view is gone is never projected, so the gap must not
		// span the chunked backfill below.
		"DROP VIEW IF EXISTS product_events_mv",
		// Frozen copy of the browser projection as of 0021, plus the two new columns.
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
		// Idempotency for the trace half only, bounded by the backfill's own window:
		// `traces` keeps 30 days and `product_events` 365, so an unbounded delete on
		// a late re-run would destroy rows the backfill cannot rebuild. The count
		// guard keeps an empty `traces` (min() = 1970) from doing the same.
		"DELETE FROM product_events WHERE Source = 'trace' AND (SELECT count() FROM traces) > 0 AND Timestamp >= (SELECT min(Timestamp) FROM traces)",
		productEventsTracesBackfill,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS product_events_traces_mv TO product_events AS
SELECT
${PRODUCT_EVENTS_TRACE_PROJECTION_SQL}
FROM traces
WHERE ${PRODUCT_EVENTS_TRACE_FILTER}`,
	],
} as const
