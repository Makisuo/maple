/**
 * The span-attribute contract that turns an instrumented span into a product
 * event. A customer marks a span they already emit:
 *
 * ```ts
 * span.setAttributes({
 *   "maple.product_event.name": "checkout_completed",
 *   "maple.product_event.user_id": user.id,
 *   "maple.product_event.include": "plan,seats",   // optional: ONLY these span keys
 *   "maple.product_event.prop.plan": "pro",        // optional: explicit prop, wins ties
 * })
 * ```
 *
 * `product_events_traces_mv` projects it into `product_events` with
 * `Source = 'trace'` and its `TraceId`/`SpanId`. The span's other attributes
 * become the event's properties by default; `include` narrows that base,
 * `prop.*` merges over it, and an EMPTY `include` leaves only the props.
 * Full write-up in `docs/product-events-funnels.md`.
 *
 * Read in two places that must agree byte for byte: `productEventsTracesMv`
 * (managed) and the frozen copy in ClickHouse migration 0028 (BYO).
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
 * Optional allow-list: comma-separated span attribute keys (whitespace trimmed),
 * and only those are copied into `Attributes`. PRESENCE switches it, not the
 * value, so present-and-empty means "no span attributes at all" — the
 * documented way to overwrite with {@link PRODUCT_EVENT_PROP_PREFIX} props.
 */
export const PRODUCT_EVENT_INCLUDE_KEY = `${PRODUCT_EVENT_ATTRIBUTE_NAMESPACE}include`

/**
 * Prefix for explicit props: `maple.product_event.prop.plan` lands in
 * `Attributes` as `plan`, merged over the base map and winning a collision.
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
 * The `product_events` projection of one annotated span, in SCHEMA column order
 * (`TraceId`/`SpanId` last, where `ADD COLUMN` put them). `Kind = 'custom'`
 * because a trace-derived event is a tracked event, not a page view; provenance
 * lives in `Source`.
 *
 * `Attributes` = `mapUpdate(base, props)`, so props win a collision:
 *   base  = span attributes minus the `maple.product_event.*` namespace,
 *           narrowed to `include`'s list when that key is PRESENT (`has(mapKeys)`)
 *   props = `maple.product_event.prop.*`, prefix stripped
 *
 * Copying the whole map by default is the deliberate expensive choice; `include`
 * is the lever. The expression only runs for rows passing the WHERE.
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
