# Product events + funnels — plan

Status: **planned, not started** (2026-08-17). Goal: answer "referral → signed up → started a
plan" for any org (and for Maple itself), from browser, mobile and backend events, as a real
funnel in the product rather than a hand-written `run_sql`.

## Where we are

Verified against production on 2026-08-17:

- `web_events` (`packages/domain/src/tinybird/datasources.ts`, `packages/query-engine/src/ch/tables.ts`)
  already exists as "the funnel substrate": time-sorted `$pageview` + `track()` rows, `EventName`
  as the step key, `Seq` tiebreak, `idx_event_name` skip index. **Nothing queries it as a funnel** —
  no `windowFunnel`/`sequenceMatch` anywhere in the repo; the `funnel` widget is a name/value bar.
- Referral (`Referrer`, `ReferrerHost`, `Utm*`), `VisitorId`, `UserId`, `GroupId` live only on
  `session_replays`. `web_events` carries `SessionId` only, so any cross-session question is a join.
- The cross-site visitor cookie works: `maple.dev` (`@maple-dev/browser`) and `app.maple.dev`
  (effect-sdk client) share `VisitorId` and land in the same org. 4 weeks: 3,462 landing visitors →
  1,979 referred → 94 reached the app → 48 identified → 22 referred + identified.
- ~⅓ of `maple-web` sessions have empty `VisitorId`/`Host` (pre-0011 SDK builds, GPC); they drop
  out of any visitor-keyed funnel.
- No `signup_completed` and no `plan_started` event exists. Plan start cannot come from the browser:
  `attach` returns a Stripe `paymentUrl` and the tab leaves; the plan starts on the Stripe → Autumn
  side. There is no server-side `track()` and no Clerk/Autumn/Stripe webhook route in `apps/api`.
- 30-day TTL on `session_replays` / `session_events` / `web_events`; `web_events` is MV-only and
  cannot be rebuilt past its source's horizon.

Today the referral → identified step is answerable with raw SQL; plan-start is not answerable at all.

## Target model

### 1. `product_events` (rename of `web_events`, widened)

`web_events` is renamed because the table stops being web-only: browser rows still arrive via the
`session_events` MV, but backend and mobile events are **direct-ingested** into the same table.

```
product_events
  OrgId        LowCardinality(String)
  Timestamp    DateTime64(9)
  Seq          UInt32                -- browser: session_events.Seq; direct: 0
  Source       LowCardinality(String) DEFAULT 'browser'   -- browser | server | mobile
  SessionId    String DEFAULT ''     -- '' for server events
  VisitorId    String DEFAULT ''     -- device/anonymous id (browser cookie, mobile install id)
  UserId       String DEFAULT ''
  GroupId      String DEFAULT ''
  Kind         LowCardinality(String)  -- navigation | custom | screen (mobile)
  EventName    String                -- '$pageview' / '$screen' / track() name
  Host         LowCardinality(String) DEFAULT ''
  PagePath     String DEFAULT ''
  Url          String DEFAULT ''
  ServiceName  LowCardinality(String) DEFAULT ''   -- which SDK/service emitted it
  Attributes   Map(String, String)
ENGINE MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, Timestamp, VisitorId, SessionId, Seq)   -- see note
TTL toDate(Timestamp) + INTERVAL 180 DAY
INDEX idx_event_name EventName TYPE set(64) GRANULARITY 4
INDEX idx_user_id    UserId    TYPE bloom_filter GRANULARITY 4
```

Decisions baked in:

- **Person key on the row.** The SDK already resolves identity lazily when session rows post and
  spans start (`clerk-auth-bridge.tsx`, `identify()`); session events get the same stamping in
  `packages/browser-session/src/events/events-sink.ts` (`visitor_id`, `user_id`, `group_id` on each
  NDJSON line). The MV copies them through. No MV-side join against `session_replays` — that would
  depend on insert ordering.
  - Requires adding `VisitorId`/`UserId`/`GroupId` (`DEFAULT ''`) to `session_events` too
    (migration + Tinybird forward query, same shape as the 0012 `Attributes` widening).
  - Rows from older SDKs arrive with `''`; the funnel falls back to a `session_replays` lookup for
    those, or simply excludes them — pick "exclude + show coverage" (matches how the analytics page
    already treats sessions without the 0011 block).
- **Sorting key**: `Timestamp` second so time ranges are a primary-index scan (the reason
  `web_events` exists), then `VisitorId` so a per-person `windowFunnel` groups over contiguous rows.
  Keep `SessionId`/`Seq` for stable step order.
- **Retention 180d**, not 30. Table is tiny (13 distinct event names, thousands of rows/month in
  the dogfood org). A referral→paid funnel spans weeks; 30d loses the tail. Browser rows can never
  be rebuilt past 30d (source TTL) — accepted; direct-ingested rows have no source and are the
  primary copy. `retention-matrix.test.ts` pins this; update it deliberately.
- **`Source` column** so a re-run of the browser backfill can `DELETE WHERE Source = 'browser'`
  instead of `TRUNCATE` (which would destroy direct-ingested rows). This replaces the
  "drop view → truncate → backfill → create view" one-writer invariant from migration 0014.
- Name: `product_events`. Not `events` (ambiguous next to `session_events`/`error_events`), not
  `analytics_events` (the page is called Web Analytics; that name will age the same way).

### 2. Direct ingest — `POST /v1/events`

Ingest gateway (`apps/ingest/src/main.rs`), NDJSON like `/v1/sessionEvents`, authenticated by
ingest key (org from the key, never the body). Body per line:

```json
{ "timestamp": "...", "name": "plan_started", "source": "server",
  "user_id": "user_…", "group_id": "org_…", "visitor_id": "", "session_id": "",
  "service_name": "maple-api", "attributes": { "plan": "startup" } }
```

- Same caps as `sanitize_session_event` (name 128, ≤32 props, key 64, value 1024, 8 KiB total).
  Reject `name` starting with `$` from direct ingest (reserved for `$pageview`/`$screen`).
- `Kind = 'custom'` unless `name = '$screen'` (mobile screen views → `Kind='screen'`).
- New `TelemetrySignal::ProductEvents`, `INGEST_TINYBIRD_DATASOURCE_PRODUCT_EVENTS`, entry in
  `clickhouse_insert_mappings.rs`, entitlement check reusing the browser-sessions feature id (or a
  new `product_events` feature — billing decision, default: reuse).
- Writes go where session events go today (Tinybird managed; BYO CH via the export lane).
- Mobile: no SDK in scope. The endpoint *is* the contract; a mobile app posts with a persistent
  install id as `visitor_id` and `identify`-equivalent `user_id`. `@maple-dev/effect-sdk` server side
  gets `track()` (`packages/effect-sdk/src/server`?) as a thin client of this endpoint so Node/Bun
  backends have the same call as the browser.

### 3. Server-side emitters for Maple's own funnel

`apps/api`:

- `ProductEventsService.track({ userId, groupId, name, attributes })` — Effect service, posts to
  the ingest gateway with Maple's own dogfood ingest key (same org that `maple-web`/`maple-landing`
  report into). `Schema.TaggedError` for the failure; never fails the caller (fire-and-forget on a
  forked fiber, `root: true` — see the ambient-span footgun).
- **`signup_completed`**: Clerk webhook `user.created` (Svix-signed) → new route
  `apps/api/src/routes/webhooks/clerk.http.ts`. `user_id` from the payload; `visitor_id` unknown
  server-side — stitching to the marketing visit happens via identity (below), not on this row.
  Fallback/complement: `apps/web` fires `signup_completed` client-side on the first
  `/quick-start` landing after Clerk `createdAt` is within N minutes; keep the webhook as truth.
- **`plan_started`**: webhook from the billing side (Autumn if it offers one for
  attach/subscription-created; else Stripe `checkout.session.completed` +
  `customer.subscription.created`, keyed back to the org via the Autumn customer id). Also emit
  synchronously in the `attach` inline-success branch (no `paymentUrl`) for the no-redirect case;
  dedup by `attributes.subscription_id`.
- Same route family later carries `plan_changed`, `plan_cancelled`.

### 4. Identity stitching

The person key for a funnel step is `if(UserId != '', UserId, VisitorId)`. Anonymous marketing
visits (VisitorId only) and server events (UserId only) meet through **`identity_links`**: an
MV over `session_replays` (and later mobile identify calls) emitting `(OrgId, VisitorId, UserId,
FirstSeen)` — ReplacingMergeTree keyed `(OrgId, VisitorId, UserId)`. The funnel query resolves
each row's person key via a `LEFT JOIN identity_links` (or `dictGet` on BYO CH) so a visitor's
pre-signup rows and their post-signup UserId rows collapse into one person. Cheap: the link table
is one row per (visitor,user) pair.

### 5. Query engine

`lib/clickhouse-builder`:
- Parametric aggregates `windowFunnel(windowSec, mode?)(ts, cond1..condN)` and
  `sequenceMatch(pattern)(ts, cond…)` following the handwritten `quantile(q)` pattern in
  `src/ch/functions/aggregate.ts:74`. `retention()` optional.

`packages/query-engine/src/ch/queries/product-events.ts` (replaces `web-analytics.ts`'s
`web_events` references; the page-view queries move here unchanged):
- `productEventsFunnelQuery({ steps, keyBy: "person" | "visitor" | "user" | "session",
  windowSeconds, filters })` → per-step `count`, `conversion_from_prev`, `conversion_from_first`.
  Step = `{ eventName } | { pagePath, host? } | { referrerHost | utmSource | ... }`. A
  session-dimension step (referral) becomes step 0's condition through the person's first
  `session_replays` row; event steps are `EventName = …` conditions on `product_events`.
- `productEventsFunnelBreakdownQuery` — same, `GROUP BY` one dimension (`UtmSource`,
  `ReferrerHost`, `Country`, `Attributes[k]`).
- `productEventNamesQuery` — the step picker's autocomplete (names + counts, 30d).
- Every query keeps `$.OrgId.eq(param.string("orgId"))`; register in `sql-catalog.ts` and add
  parity coverage in the ClickHouse e2e like `web-analytics-parity.clickhouse.e2e.test.ts`
  (seed dates must be now-relative — TTL).
- `apps/api/src/routes/internal/query-engine.http.ts` fallback message and the
  `useWebEvents` switch get renamed (`useProductEvents`), same "absent table → raw
  `session_events`" degrade for page views; funnels **require** the table (no raw fallback —
  server/mobile rows only exist there).

### 6. Surfaces

- **Dashboard widget**: new `funnel` config that is step-based (not group-by). Today's `funnel`
  render shape stays as the renderer; the *widget type* gains `steps[]`, `keyBy`, `window`.
  `packages/domain/src/http/v2/dashboards.ts` + parity test, `dashboard-schema-doc.ts` for MCP.
- **`/analytics` → Funnels tab** reusing the existing filter sidebar (`WebAnalyticsFilters` become
  `ProductEventsFilters`), plus an event-name breakdown panel.
- **MCP**: `query_funnel` tool (or a `funnel` mode on `query_data`) and `list_product_events`.
- Docs (`apps/landing/src/content/docs/…`): `track()` server-side, `/v1/events`, funnels page.

## Migration / rename sequence

Order matters because `web_events` has no dedup and `session_events` still holds every browser
row for 30d — the rename is a rebuild, not a `RENAME TABLE`.

1. Migration `0016_product_events` (BYO CH) + Tinybird datasource `product_events` + MV
   `product_events_mv` (from `session_events`, with the new columns), backfill spec from
   `session_events` for the last 30d (same row-wise projection idea as 0014, `Source='browser'`).
   Also `0016` adds `VisitorId/UserId/GroupId` to `session_events` (+ Tinybird forward query).
2. Local CLI: `local-schema-v6.sql`, `local-store-migrations/v5-to-v6-product-events.ts`
   (+ test), bump the schema-version gate.
3. SDKs stamp identity on session events (`browser-session` events-sink; effect-sdk client
   `track.ts`). Backwards compatible — defaults cover old builds.
4. Ingest: `/v1/events`, mappings, signal, env; deploy.
5. Query engine: flip page-view readers `web_events → product_events`; add funnel queries;
   catalog + parity tests; `useWebEvents` rename.
6. Web/MCP surfaces.
7. `apps/api`: `ProductEventsService`, Clerk + billing webhooks, `attach` inline emit.
8. After one full deploy cycle with both tables populated and reads on the new one: migration
   `0017_drop_web_events` (drop MV then table) and remove the Tinybird datasource; delete the
   `web_events` local-schema entries going forward (old versions keep them for the migration chain).

## Open decisions (defaults chosen; flag if you disagree)

- Retention **180d** for `product_events` (could be 365; cost is negligible either way).
- Reuse the browser-sessions entitlement for `/v1/events` rather than a new billable feature.
- Person key = `UserId` else `VisitorId`, stitched through `identity_links`; no probabilistic
  matching.
- `signup_completed` truth = Clerk webhook, not the client.
- Mobile SDK is **not** in scope; the HTTP contract is.

## Quick win available before any of this

Referral → identified in app → `onboarding_step_completed` as a `raw_sql_chart` widget over
`session_replays` + `web_events` (the join used for the numbers above). ~15 min, no schema change,
missing only the plan-start step.
