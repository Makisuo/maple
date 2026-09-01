/**
 * The span-attribute contract that turns an instrumented span into a product
 * event — "annotate in code, not in the UI".
 *
 * A customer marks a span they already emit:
 *
 * ```ts
 * span.setAttributes({
 *   "maple.product_event.name": "checkout_completed",
 *   "maple.product_event.user_id": user.id,
 * })
 * ```
 *
 * The span's own attributes come along whole by default — every key it already
 * carries becomes an event property, with no opt-in list and no prefix to
 * remember. The span IS the event, so anything worth putting on the span is
 * worth breaking the funnel down by.
 *
 * Two optional controls narrow or replace that default, both themselves span
 * attributes, because a materialized view is static SQL per cluster and has no
 * per-org config to read:
 *
 * ```ts
 * "maple.product_event.include": "plan,seats"   // ONLY these span keys
 * "maple.product_event.prop.plan": "pro"        // explicit prop, wins ties
 * "maple.product_event.include": ""             // and together: full overwrite
 * ```
 *
 * Three tiers out of one mechanism rather than three modes to choose between:
 * `include` narrows the base map, `prop.*` merges over it, and an EMPTY
 * `include` narrows the base to nothing so the props are all that survive. There
 * is no separate "replace" flag to get wrong.
 *
 * and `product_events_traces_mv` projects it into `product_events` with
 * `Source = 'trace'` and the span's `TraceId`/`SpanId` carried through, so the
 * event steps in a funnel like any `track()` call AND links back to the trace it
 * came from. Nothing is written by hand and nothing is stored twice: the span is
 * the record, the product event is its projection.
 *
 * Why an attribute rather than a UI action: a product event has to be emitted by
 * the code path that actually performed the thing, at the moment it performed
 * it. A human clicking "this trace was a signup" a day later marks ONE sampled
 * trace, cannot be replayed over history, and puts a mutable, user-authored row
 * into an append-only fact table. An attribute marks every trace the path
 * produces, forever, and is reviewable in the customer's own diff.
 *
 * These keys are read in exactly two places, which must agree byte for byte:
 * `productEventsTracesMv` in `materializations.ts` (managed orgs) and the frozen
 * MV body in ClickHouse migration 0024 (BYO clusters).
 */

/** Vendor namespace prefix. Every key below starts with it. */
export const PRODUCT_EVENT_ATTRIBUTE_NAMESPACE = "maple.product_event."

/**
 * Required. Its presence — a non-empty value — is the whole predicate: a span
 * carrying it becomes a product event, a span without it is ignored. The value
 * becomes `EventName`, i.e. the funnel step key.
 */
export const PRODUCT_EVENT_NAME_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}name`

/** Optional identity. Absent keys project to `''`, which means "unidentified". */
export const PRODUCT_EVENT_USER_ID_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}user_id`
export const PRODUCT_EVENT_GROUP_ID_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}group_id`
export const PRODUCT_EVENT_VISITOR_ID_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}visitor_id`

/**
 * Optional page context, for events that belong to a URL (a server-rendered
 * checkout, a webhook that knows the page it came from).
 */
export const PRODUCT_EVENT_URL_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}url`

/**
 * Optional allow-list: a comma-separated list of span attribute keys, and only
 * those are copied into `Attributes`. Whitespace around each entry is trimmed,
 * so `"plan, seats"` and `"plan,seats"` mean the same thing.
 *
 * PRESENCE is what switches the behaviour, not the value — which is why the
 * projection tests it with `mapContains` and not `!= ''`. Present and empty
 * therefore means "no span attributes at all", and that is the documented way to
 * OVERWRITE rather than narrow: set it empty and supply {@link
 * PRODUCT_EVENT_PROP_PREFIX} props, and the event carries exactly those.
 */
export const PRODUCT_EVENT_INCLUDE_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}include`

/**
 * Prefix for explicit props. `maple.product_event.prop.plan` lands in
 * `Attributes` as `plan`, MERGED OVER whatever the base map produced and winning
 * on a key collision — so a team can override one derived value without having
 * to enumerate everything else with {@link PRODUCT_EVENT_INCLUDE_KEY}.
 */
export const PRODUCT_EVENT_PROP_PREFIX = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}prop.`

/**
 * OTel's own session key, read as a fallback so a browser-originated trace can
 * stitch to the same session its `session_events` rows carry.
 */
export const PRODUCT_EVENT_SESSION_ID_KEY = "session.id"

/**
 * `Source` value for a trace-derived row. Joins `browser` (session_events MV),
 * `server` and `mobile` (`POST /v1/events`).
 */
export const PRODUCT_EVENT_SOURCE_TRACE = "trace"

/**
 * The `product_events` projection of one annotated span, shared byte-for-byte
 * between the managed materialized view and the BYO-ClickHouse migration's
 * frozen copy — as with 0021's browser projection, two copies of this SELECT is
 * two chances for the same span to be counted two different ways.
 *
 * Column order matches the `product_events` SCHEMA order, `TraceId`/`SpanId`
 * last because that is where `ALTER TABLE … ADD COLUMN` puts them.
 *
 * `Kind = 'custom'` deliberately: `Kind` is the page-view predicate every reader
 * already branches on, and a trace-derived event is a tracked event, not a page
 * view. Provenance lives in `Source`, which is what the trace link reads.
 *
 * `Seq = 0` like every other direct row; ordering inside a millisecond comes
 * from the span's own nanosecond `Timestamp`.
 *
 * `Attributes` is built in two halves and merged, `mapUpdate` letting the props
 * win a collision:
 *
 *   base  = span attributes, minus the `maple.product_event.*` control
 *           namespace, optionally narrowed to `include`'s allow-list
 *   props = `maple.product_event.prop.*`, prefix stripped
 *
 * The default — neither control set — is the whole span map, which is the
 * expensive choice and the deliberate one: a server span carries its full
 * HTTP/DB semconv surface, and `product_events` keeps 365 days against raw
 * `traces`' 30, so an annotated span's attributes outlive the span by a factor
 * of twelve. What it buys is that nothing has to be declared to get started, and
 * `include` is the lever for a team that has measured the cost and wants it back.
 *
 * The control namespace IS stripped from the base, unlike an earlier cut of
 * this projection. Once `prop.*` exists, leaving it in means every explicit prop
 * appears twice — once as `plan` from the merge and once as
 * `maple.product_event.prop.plan` from the base — and `name`/`user_id` duplicate
 * columns this same SELECT already promotes.
 *
 * The whole expression only evaluates for rows that pass the WHERE below, i.e.
 * annotated spans, so its cost is paid per product event rather than per span.
 * The predicate itself stays a single map lookup.
 */
export const PRODUCT_EVENTS_TRACE_PROJECTION_SQL = `OrgId,
  Timestamp,
  '${PRODUCT_EVENT_SOURCE_TRACE}' AS Source,
  SpanAttributes['${PRODUCT_EVENT_SESSION_ID_KEY}'] AS SessionId,
  0 AS Seq,
  SpanAttributes['${PRODUCT_EVENT_VISITOR_ID_KEY}'] AS VisitorId,
  SpanAttributes['${PRODUCT_EVENT_USER_ID_KEY}'] AS UserId,
  SpanAttributes['${PRODUCT_EVENT_GROUP_ID_KEY}'] AS GroupId,
  'custom' AS Kind,
  SpanAttributes['${PRODUCT_EVENT_NAME_KEY}'] AS EventName,
  domain(SpanAttributes['${PRODUCT_EVENT_URL_KEY}']) AS Host,
  path(SpanAttributes['${PRODUCT_EVENT_URL_KEY}']) AS PagePath,
  SpanAttributes['${PRODUCT_EVENT_URL_KEY}'] AS Url,
  ServiceName,
  mapUpdate(
    CAST(
      mapFilter(
        (k, v) -> NOT startsWith(k, '${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}')
          AND (
            NOT has(mapKeys(SpanAttributes), '${PRODUCT_EVENT_INCLUDE_KEY}')
            OR has(
              arrayMap(
                key -> trimBoth(key),
                splitByChar(',', SpanAttributes['${PRODUCT_EVENT_INCLUDE_KEY}'])
              ),
              k
            )
          ),
        SpanAttributes
      ),
      'Map(String, String)'
    ),
    mapApply(
      (k, v) -> (substring(k, ${PRODUCT_EVENT_PROP_PREFIX.length + 1}), v),
      mapFilter((k, v) -> startsWith(k, '${PRODUCT_EVENT_PROP_PREFIX}'), SpanAttributes)
    )
  ) AS Attributes,
  TraceId,
  SpanId`

/**
 * The predicate, also shared. `!= ''` rather than `mapContains`: a key present
 * with an empty value would otherwise mint an event with no name, which is a row
 * no funnel can step on and no reader can attribute.
 */
export const PRODUCT_EVENTS_TRACE_FILTER = `SpanAttributes['${PRODUCT_EVENT_NAME_KEY}'] != ''`
