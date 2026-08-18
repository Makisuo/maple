# Charts in alert notifications — implementation plan

**Verdict: yes, and `renotify` is what justifies it.**

A `trigger` message says what broke. A `renotify` currently repeats
`4.2% > 2%` every 30 minutes and answers nothing — you cannot tell recovering
from worsening without opening Maple. A chart of the incident so far, with the
threshold drawn on it, turns each re-alert into a status update instead of a
duplicate. Secondary value on `trigger` (spike or step change?) and `resolve`
(did it recover, or did the data stop?).

## The whole design in one paragraph

`alert_checks` already holds one immutable audit row per rule per minute for
365 days, for every org. A chart is that table, filtered to one rule and one
window, drawn. So: read it once when queueing a notification to bake a
sparkline into the message text, put a **signed URL naming the window** in the
Slack/Discord/email body, and let `apps/web` rasterise that window on demand
with the wasm it already ships. No new table, no snapshot, no second series
source, no retention sweep.

## Two simplifications over the first draft

### 1. There is no BYO-ClickHouse fallback to write — I had this backwards

The first draft carried `evaluateSeries` as a second source because
`alert_checks` "only exists in the managed pipeline". That describes a bug that
was **already fixed**. Today the routing is structural on both sides:

- **Write:** `warehouse.ingest(...)` is hard-pinned to the managed Tinybird
  ingest config (`AlertsService.ts:2985`), for every org including BYO-CH.
- **Read:** `listRuleChecksQuery` declares `.routing("ingest")`
  (`packages/query-engine/src/ch/queries/alert-checks.ts`), so `compiledQuery`
  resolves the same managed config rather than the org's own cluster.

`alert_checks` is therefore universally available. **`evaluateSeries` is out of
the plan entirely** — one source, no fallback, and no "both paths must produce
the same `ChartPoint[]`" invariant to keep honest.

### 2. No snapshot table — the audit log *is* the snapshot

The first draft persisted the points so an old message's image could not
silently re-render against new data. But `alert_checks` is append-only and
immutable with 365-day retention (`migration_0009`, `retention-matrix.test.ts`:
`alert_checks: 365`). Pin the window in the signed URL and the same query
returns the same rows forever — determinism without storing anything.

Deleted from the plan: the `alert_chart_snapshots` table, its migration, the
jsonb points column, the snapshot id in `payload_json`, and the retention
sweep entry.

**The trade this makes:** one warehouse read per uncached image GET, instead of
one write plus storage. Bounded by a long-`s-maxage` edge cache (the bytes are
immutable), the existing `ApiV2RateLimiter`, and the signature — which fixes
the window, so nobody can turn the URL into an arbitrary-range scan. Slack and
Discord fetch an image once and re-host it, so misses are rare.

**Rejected: encoding the points directly in the URL.** It kills the second read
too, but 60 points is a URL whose length varies with the data, and Slack,
Discord and email cap URL length differently. A design that works until a
noisy metric makes the URL too long is worse than one extra cached read.

## Decisions that survive from the first draft

- **Window:** `from = min(firstTriggeredAt − 2×window, now − 6×window)`,
  `to = now`, capped at 60 points by striding that keeps local maxima on the
  breach side. Pre-breach baseline on `trigger`; grows with the incident on
  `renotify`. Threshold as a dashed rule with the breach region shaded — that
  is what makes it readable at phone size.
- **Delivery by URL, not upload.** Slack `image` block, Discord
  `embed.image.url`, email `<img>` all take a URL; per-provider uploads would
  be three mechanisms (Slack `files.uploadV2`, Discord multipart, email CID)
  and would push a wasm renderer into the alerting worker.
- **Signed like `shareOgId`** — base64url params + constant-time HMAC under
  `MAPLE_SHARE_TOKEN_HMAC_KEY` (`packages/db/src/share-token-hash.ts`). A
  bearer URL for one metric series with no PII, same exposure class as an
  existing public dashboard share. Per-org opt-out keeps the sparkline only.
- **Rasterise with the wasm `apps/web` already has** — confirmed by the stage 0
  spike, with one constraint that shapes the chart's design (see below).
- **Always ship the sparkline**, image or not. `▁▂▄█▆▃ 4.2% (was 1.1%)` in the
  Slack context block and Discord footer. An `image` block does not render on a
  lock screen, and this is the degrade path when anything else fails.
- **Only where the shape exists.** Grouped rules chart the firing group only.
  A rule with no `alert_checks` history yet gets no chart and no sparkline, and
  every downstream step is a no-op. Nothing in the notification path may start
  depending on a chart being present.

## Stages (was six, now four)

### Stage 0 — spike — DONE, and it constrains the design

**Result: takumi rasterises the SVG, but drops every glyph inside it.**

Feeding a `chart.ts` SVG to takumi as a data-URI image node draws the geometry
perfectly — paths, gradient fill, stroke, the point dot, grid lines, the
rounded card. Text inside the SVG renders as nothing. `Renderer.registerFont`
does not fix it: output was **byte-identical** (7047 bytes) before and after
registering Geist Mono, because `registerFont` feeds takumi's own layout
engine, not the usvg fontdb behind its SVG decoder.

Text as **takumi nodes** renders correctly in Geist Mono, in the same image,
composed around the SVG.

So the notification chart is a **hybrid**: SVG for plot geometry, takumi nodes
for every piece of type. Two consequences:

1. `chart.ts` splits into `renderPlotSvg(spec)` (geometry only, no `<text>`)
   plus the existing `renderChartSvg` (geometry + text) that `apps/slack-agent`
   keeps using — it rasterises with `@resvg/resvg-js`, which has fonts and is
   unaffected. One module, two consumers, shared scale maths, no fork.
2. **Drop y-axis tick labels from the notification chart.** Positioning them as
   takumi nodes would mean exporting the projection maths just to re-align text
   with grid lines. Instead: title, current value, threshold label pinned to
   the threshold rule, and start/end timestamps — all flexbox, no absolute
   positioning. Better at phone size than a four-tick axis anyway.

Rejected alternative: `@resvg/resvg-wasm` (~2.5 MB) has its own fontdb and
would keep `chart.ts` in one piece — but it stacks a second rasteriser on top
of takumi's 3.7 MB for one feature, and the label set above is a better chart
at Slack size regardless.

### Stage 1 — shared chart module + sparkline everywhere

- Move `apps/slack-agent/agent/lib/chart.ts` → `packages/ui/src/charts/static/`.
  It knows Maple design tokens, so `packages/`, not `lib/`. Its bun tests move
  with it; `apps/slack-agent` imports from the new home.
- Split out `renderPlotSvg(spec)` (geometry, no `<text>`) alongside the existing
  `renderChartSvg`, per stage 0.
- `mapSignalUnit(SignalUnit): ChartUnit` in `alert-signal-display.ts` —
  `ratio→percent`, `ms→duration_ms`, `rpm→requests_per_sec`,
  `apdex|count|plain→number`.
- `alert-chart-series.ts`: `loadCheckSeries(orgId, ruleId, groupKey, from, to)`
  over `listRuleChecksQuery`, returning `ChartPoint[]` + threshold. Short
  timeout, `Effect.orElseSucceed(null)` — a slow warehouse must never delay or
  drop a page.
- Call it once in `queueIncidentNotifications` (`AlertsService.ts:663`);
  `buildPayload` (`AlertDestinationDelivery.ts:132`) and
  `StoredDeliveryPayloadSchema` each gain an optional `sparkline` string.
- Sparkline into `buildSlackContextBlock` and the Discord embed footer
  (`AlertDeliveryDispatch.ts:184`, `:218`).

Ships alone, and is most of the renotify value.

### Stage 2 — signed chart URL + image route

- `chartImageId({orgId, ruleId, groupKey, from, to, unit}, hmacKey)` next to
  `shareOgId` in `packages/db/src/share-token-hash.ts`, with a constant-time
  verify.
- `POST /v2/alerts/chart-series` on the `sharePublic` group
  (`share.http.ts`): verify the id, rate-limit it as `ogMeta` does
  (`share.http.ts:349`), run the same `loadCheckSeries`, return points +
  threshold + rule name. No auth — the signature is the capability.
- `apps/web/src/og/`: `alertChartIdFromPath` beside `ogIdFromPath`, and
  `renderAlertChart` mirroring `renderShareOgImage`; routed in
  `apps/web/src/worker.ts` ahead of the assets lookup like `/share/og/`.
  Long `s-maxage` — the window is pinned, so the bytes are immutable.
- The URL is composed at dispatch time in `processOneDelivery`
  (`AlertsService.ts:~1334`) next to `linkUrl`/`chatUrl`, from the incident and
  rule rows it already has. Nothing new rides in `payload_json`.

### Stage 3 — transports

`DispatchContext` gains `chartUrl: string | null`. Then pure `render` changes:
Slack `image` block before the actions block, Discord `embed.image.url`, email
`<img>` in `alert-email.ts`. Extend `delivery/transports/render.test.ts` —
every provider asserted with and without a chart.

### Stage 4 — templates and settings

`{{chartUrl}}` / `{{sparkline}}` bindings in `alert-templating/renderer.ts` and
`defaultTemplates.ts`; per-org "attach charts" toggle (default on) with a
per-rule override.

## Costs and risks

- **One warehouse read per notification** (queue time, for the sparkline) plus
  **one per uncached image GET**. Both are `list`-profile scans on
  `alert_checks`; renotify is interval-gated at 30 min by default.
- **Bearer image URLs** — accepted precedent (`dashboard_shares`), one metric
  series, org opt-out available.
- **Every chart step must degrade to the sparkline, and the sparkline to
  nothing** — never to a missing or delayed alert. Assert explicitly in the
  dispatch tests: series read failing, resolve endpoint down, and renderer
  throwing must each still deliver the message.
