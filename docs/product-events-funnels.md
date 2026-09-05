# Product events + funnels — plan

Status: **implemented in code (2026-08-17), pending rollout.** Goal: answer "referral → signed
up → started a plan" for any org (and for Maple itself), from browser, mobile and backend events,
as a real funnel in the product rather than a hand-written `run_sql`.

## Rollout checklist (operator steps the code cannot do)

1. **Tinybird**: `bun run --cwd apps/api tinybird:deploy` creates `product_events`,
   `identity_links` and their MVs. Then populate both from their sources with an explicit `tb`
   step (the SDK has no populate option — same caveat as 0014). Until populated, page views
   read as zero on managed orgs. Old `web_events`/`web_events_mv` can be removed from the
   workspace afterwards.
2. **BYO ClickHouse**: migration 0021 bumps `clickHouseSchemaVersion` to 21 (`requiredForIngest`
   default), so BYO orgs' ingest routing is un-ready until they apply schema. Deliberate — the
   gateway now writes the new `session_events` columns and `product_events` directly.
3. **Secrets** (api worker): `CLERK_WEBHOOK_SECRET`, `AUTUMN_WEBHOOK_SECRET` (both routes answer
   503 until set); optional `MAPLE_PRODUCT_EVENTS_INGEST_KEY` (defaults to `MAPLE_INGEST_KEY`).
   Register `POST /webhooks/clerk` (event `user.created`) in Clerk and `POST /webhooks/autumn`
   (`billing.updated`) in Autumn.
4. **Ingest**: `INGEST_TINYBIRD_DATASOURCE_PRODUCT_EVENTS` defaults to `product_events`; nothing
   to set unless the datasource name differs.
5. Publish `@maple-dev/effect-sdk` / `@maple-dev/browser` so customers' events start carrying
   identity; older builds keep writing (all new columns default).
6. **Billing**: `bun run --cwd apps/api atmn push` (no package script exists; `atmn` is an
   `apps/api` dependency) so the `product_events` feature and its `startup` plan item exist in
   Autumn before the gateway starts reserving against it. Until pushed, Autumn answers
   `allowed: false` for the unknown feature — a real denial, not an error, so `is_allowed`'s
   fail-open does NOT rescue it. Neither event path rejects on `product_events` for exactly that
   reason: usage is recorded fail-open and nothing is dropped — just unbilled.

### Billing

Product events are their own metered Autumn feature, `product_events` (unit = one event),
separate from `browser_sessions`. The ingest gateway meters it on two paths, both with the same
reserve → WAL enqueue → confirm/release shape as session starts (`metered_enqueue` in
`apps/ingest/src/main.rs`): (1) `POST /v1/events` reserves the number of rows that survived
`sanitize_product_event`; (2) `POST /v1/sessionEvents` reserves the number of `type == "custom"`
rows in the batch (a browser `track()` call is the same unit as a server-side event) and keeps its
entitlement REJECTION on `browser_sessions`. **Neither path rejects on `product_events`**: an
exhausted (or un-provisioned) product-events allowance bills usage-based overage instead of 402-ing
a whole session transcript or a backend's buffered batch. Automatic session events (clicks, navigations, ...) stay unmetered. **Beta pricing
(2026-08-17): the `startup` item is `unlimited: true` with no price** — usage is tracked in Autumn
(and shown on the billing page as "Unlimited · free during beta") so real volumes are known before
a price is set. To start charging, swap `unlimited` for an `included` allowance + `price` in
`apps/api/autumn.config.ts` (the commented example is $0.05 per 1,000 events past 1M/month) and
push. `DailySpendService` emits `DailyVolume.productEvents` from `product_events`
(`Kind != 'navigation'`, matching what the gateway meters).

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
{
	"timestamp": "...",
	"name": "plan_started",
	"source": "server",
	"user_id": "user_…",
	"group_id": "org_…",
	"visitor_id": "",
	"session_id": "",
	"service_name": "maple-api",
	"attributes": { "plan": "startup" }
}
```

- Same caps as `sanitize_session_event` (name 128, ≤32 props, key 64, value 1024, 8 KiB total).
  Reject `name` starting with `$` from direct ingest (reserved for `$pageview`/`$screen`).
- `Kind = 'custom'` unless `name = '$screen'` (mobile screen views → `Kind='screen'`).
- New `TelemetrySignal::ProductEvents`, `INGEST_TINYBIRD_DATASOURCE_PRODUCT_EVENTS`, entry in
  `clickhouse_insert_mappings.rs`, entitlement check + per-row metering against the new
  `product_events` feature (see "Billing" above).
- Writes go where session events go today (Tinybird managed; BYO CH via the export lane).
- Mobile: no SDK in scope. The endpoint _is_ the contract; a mobile app posts with a persistent
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
- Every query keeps `$.OrgId.eq(param.string("orgId"))`; register in `benchmark/catalog.ts` and add
  parity coverage in the ClickHouse e2e like `web-analytics-parity.clickhouse.e2e.test.ts`
  (seed dates must be now-relative — TTL).
- `apps/api/src/routes/internal/query-engine.http.ts` fallback message and the
  `useWebEvents` switch get renamed (`useProductEvents`), same "absent table → raw
  `session_events`" degrade for page views; funnels **require** the table (no raw fallback —
  server/mobile rows only exist there).

### 6. Surfaces

- **Dashboard widget**: new `funnel` config that is step-based (not group-by). Today's `funnel`
  render shape stays as the renderer; the _widget type_ gains `steps[]`, `keyBy`, `window`.
  `packages/domain/src/http/v2/dashboards.ts` + parity test, `dashboard-schema-doc.ts` for MCP.
- **`/analytics` → Funnels tab** reusing the existing filter sidebar (`WebAnalyticsFilters` become
  `ProductEventsFilters`), plus an event-name breakdown panel.
- **MCP**: `query_funnel` tool (or a `funnel` mode on `query_data`) and `list_product_events`.
- Docs (`apps/landing/src/content/docs/…`): `track()` server-side, `/v1/events`, funnels page.

## Migration / rename sequence

Order matters because `web_events` has no dedup and `session_events` still holds every browser
row for 30d — the rename is a rebuild, not a `RENAME TABLE`.

1. Migration `0021_product_events` (BYO CH) + Tinybird datasource `product_events` + MV
   `product_events_mv` (from `session_events`, with the new columns), backfill spec from
   `session_events` for the last 30d (same row-wise projection idea as 0014, `Source='browser'`).
   Also `0021` adds `VisitorId/UserId/GroupId` to `session_events` (+ Tinybird forward query).
2. Local CLI: `local-schema-v11.sql`, `local-store-migrations/v10-to-v11-product-events.ts`
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
- ~~Reuse the browser-sessions entitlement for `/v1/events` rather than a new billable feature.~~
  Superseded 2026-08-17: `product_events` is its own metered feature (see "Billing").
- Person key = `UserId` else `VisitorId`, stitched through `identity_links`; no probabilistic
  matching.
- `signup_completed` truth = Clerk webhook, not the client.
- Mobile SDK is **not** in scope; the HTTP contract is.

## Quick win available before any of this

Referral → identified in app → `onboarding_step_completed` as a `raw_sql_chart` widget over
`session_replays` + `web_events` (the join used for the numbers above). ~15 min, no schema change,
missing only the plan-start step.

## Status: the dashboard funnel widget (2026-08)

The funnel widget's definition is edited as its **query panel** (`FunnelQueryPanel`,
`apps/web/src/components/dashboard-builder/config/funnel-query-panel.tsx`): the panel's source
select offers **Product events** beside Traces / Logs / Metrics (a query-builder source is the
original group-by breakdown drawn as a funnel). The product-events body is the ordered steps —
event steps take a per-step attribute filter (`plan = "pro" AND source = "cli"` →
`attributeEquals`), page steps an optional host — a population where-clause over the session
dimensions (`country = "DE" AND utm.source = "twitter"` → `display.funnel.filters`), and Count by /
Window / Breakdown as add-ons. The definition persists on `display.funnel` and is mirrored flat into
the `product_events_funnel` route params (`ProductEventsFunnelWidgetParams` in `@maple/query-model`),
which the browser server function and the share API's route plan both decode. With a breakdown the
route answers `{ name, value, group }` rows (top 6 groups by step-1 count) and the funnel chart draws
one bar per group per step with a legend.
