# Maple for iOS — what the app is for

The phone is not a smaller dashboard. It answers three questions, in this
order, and nothing else earns a tab:

1. **Is anything wrong right now?** — one glance, no scrolling.
2. **Why is it going off?** — enough context to decide "page someone / wait /
   it's known" without opening a laptop.
3. **Tell me when it happens.** — push, with the same context, deep-linked.

Everything the web app does that isn't in service of those (dashboards, query
building, replay, settings) stays on the web.

## Information architecture

Three tabs + a profile sheet. The current Services/Issues split goes away.

```
Home        Services        Alerts                 (profile sheet: org switch,
                                                    notifications, sign out)
```

### Home — "the pulse"

Everything above the fold answers question 1.

- **Status headline.** Derived on-device, no new endpoint:
  `All 14 services healthy` · `2 degraded, 1 critical alert` · `No data in
  the last hour` (liveness — an org that stopped sending is *not* healthy).
  Colour follows the worst thing on screen; amber primary used here and only
  here.
- **Open incidents**, critical first, each a card: rule name · service(s) ·
  `observed vs threshold` in the rule's unit · how long open · a 1h sparkline
  of the signal. Tap → Incident detail. Empty state is a real sentence, not
  a placeholder.
- **Services needing attention**: services whose health isn't `healthy`,
  sorted worst-first (health-dot · name · error rate · p95). "All healthy"
  collapses this to a single line. Tap → Service detail. "See all" → Services
  tab.
- **New in the last 24h**: count of new/regressed error issues and anomalies,
  each a row that opens the Alerts tab pre-filtered.
- Pull-to-refresh; auto-refresh every 60s while foregrounded.

Time window is fixed to *now* (1h for rates, 24h for "new"). Home has no time
picker — a time picker is a question-2 tool.

### Services

The existing list, kept: health-dot, name, throughput, error rate, p95,
sorted worst-first. Time window picker (1h · 6h · 24h · 7d) lives here.

**Service detail** gets: health headline, four stat tiles (throughput, error
rate, p95, p99) each with a sparkline (`POST /v2/traces/timeseries`), open
incidents scoped to this service, top error issues for this service, top
operations by errors and by latency (`POST /v2/traces/breakdown` grouped by
span name). No trace waterfall on the phone — link out to the web for that.

### Alerts

The triage hub. Segmented control at the top: **Incidents · Errors ·
Anomalies**. Default segment is whichever has open items, incidents first.

- Incidents: open then resolved, grouped by rule; severity badge, service,
  duration, observed/threshold. Filter chips: open · critical · mine
  (rules for services I follow — later).
- Errors: the current Issues list, unchanged in content, restyled as rows
  (title · service · count · last seen · sparkline).
- Anomalies: `GET /v2/anomalies/incidents`, same row shape.

**Incident detail** — the "why" screen. Top to bottom:

1. Headline: `Checkout error rate · 9.0% > 5.0% · open 32 min · critical`.
2. **What the rule saw**: the check history for this rule/group
   (`GET /v2/alerts/rules/{id}/checks`) rendered as a bar/line of observed
   values with the threshold line. This works for *every* signal type
   including builder/raw queries, because it's the rule's own observations,
   not a re-query.
3. **What changed on the service** (only for the five service signals): the
   affected service's error-rate / p95 / throughput timeseries around the
   incident window, from `/v2/traces/timeseries`. This is where a latency
   alert shows "throughput also spiked" or "errors did too".
4. **Likely cause**: linked error issue if `error_issue_id` is set; otherwise
   top error issues for the service in the window (`GET /v2/error_issues`
   filtered by service, sorted by first-seen desc). Top failing operations
   from a breakdown by span name.
5. **Timeline**: trigger / renotify / resolve events and where they went
   (`GET /v2/alerts/deliveries?incident_id=`).
6. Actions: **Open on web** (deep link into the same incident), **Share**
   (link + headline). Incidents can't be closed via the API — no fake
   "acknowledge" button. Mute-rule is a later addition once we decide it
   belongs on the phone.

**Error issue detail** stays roughly as-is: title, message, service, first/
last seen, occurrence sparkline, stack, linked incidents. Actions: open on
web, share.

### Profile sheet

Org switcher (existing), **Notifications** (per-org toggles: critical
incidents · warning incidents · resolved · new error issues · anomalies), sign
out. Nothing else.

## Health model

Reuse the thresholds already ported into `Primitives.swift` from
`service-health.ts` / `latency-tone.ts` — the phone must agree with the
browser about what "degraded" means. Home's headline is `max` over per-service
health, then bumped to critical if any open incident is critical, then to
"no data" if `throughput == 0` across the org for the last hour.

## API surface

Reads needed, all in v2 already:

| Screen | Operations |
| --- | --- |
| Home | `listServices` (1h), `listAlertIncidents?status=open`, `listErrorIssues` (24h, sort first_seen), `listAnomalyIncidents`, `queryTraceTimeseries` for sparklines |
| Services | `listServices`, `getService`, `queryTraceTimeseries`, `queryTraceBreakdown`, `listAlertIncidents`, `listErrorIssues` |
| Alerts | `listAlertIncidents`, `getAlertIncident`, `getAlertRule`, `listAlertRuleChecks`, `listAlertDeliveries`, `listErrorIssues`, `getErrorIssue`, `listAnomalyIncidents`, `getAnomalyIncident`, `getAnomalyIncidentTimeseries` |

Add these `operationId`s to `IOS_OPERATIONS` in `scripts/generate-ios-openapi.ts`.
Sparkline queries: batch per screen, 1h/24 buckets, `p95_duration` and
`error_rate` aggregations — cheap, and the API is already cost-profiled.

Gaps to fill on the API side (small):

- `listAlertIncidents` filtered by service name — today filter is `rule_id`/
  `status`. Either add `service_name` or the app joins client-side via the
  rule's `service_names` (fine for the first version; org rule counts are
  small).
- Error issue **occurrence timeseries** isn't in v2 (`events` is deferred).
  Sparklines on issue rows can wait, or use `/v2/traces/timeseries` filtered
  by `status = Error` + service as a proxy.

## Push notifications

### Product

Notify on: incident **triggered** (critical → time-sensitive interruption
level; warning → active), incident **resolved** (quiet), **new** error issue,
**regressed** error issue, anomaly opened. Per-org, per-user toggles in the
profile sheet. Ask for permission the first time the user opens an incident
or flips a toggle — never at launch.

Payload = the Home card: `Checkout error rate — 9.0% > 5.0% on checkout-api`,
subtitle with severity + duration, thread by `dedupe_key` so renotifies
collapse, deep link `maple://incidents/{id}` (universal link
`https://app.maple.dev/…` so it also works with the app absent). Later:
a Live Activity on the Lock Screen while a critical incident is open.

### Backend shape

Alert destinations are **org-scoped** (Slack channel, PagerDuty…); push is
**user-scoped**. Don't model a phone as a destination. Instead:

- `mobile_devices` table: `user_id`, `org_id`, `platform`, `token`,
  `environment` (sandbox/prod), `preferences` (the toggles), `last_seen_at`.
  Register/refresh via `PUT /v2/me/devices/{token}`, delete on sign-out /
  APNs feedback.
- A `pushFanOut` step in `NotificationDispatcher` (the same shared path error
  issues and incidents already use), keyed off the event type — independent
  of which rule destinations exist, so a rule with zero destinations still
  reaches phones. Filter by device preferences, dedupe by
  `(dedupe_key, event_type)`.
- Transport: **APNs requires HTTP/2**, which the Workers `fetch` API doesn't
  guarantee to origins. Verify before committing to direct APNs from
  `apps/alerting`; if it fails, relay through FCM (HTTP v1 works over
  HTTP/1.1, and covers Android later) or run the sender where HTTP/2 egress
  is available (the ingest gateway's host). Decide this first — it's the only
  real unknown in the plan.
- Deliveries table already records attempts per destination; record push
  sends there too (destination type `mobile`) so the incident timeline shows
  "notified 3 devices".

## Sequencing

1. Home + Alerts (incidents) + incident detail. Requires only new
   `IOS_OPERATIONS`. This is the app.
2. Service detail expansion, anomalies segment.
3. Push: transport spike → devices endpoint → fan-out → iOS registration
   and settings sheet.
4. Live Activity, follow-a-service, mute-rule — only after 1–3 are in
   people's hands.

## Design

`DESIGN.md` conventions hold (Geist Mono body, hairlines, tonal depth, one
amber per screen, skeletons not spinners). Home is the screen that has to be
beautiful; the rest can be dense. Sparklines are 1px lines with no axes; the
threshold on incident charts is a dashed hairline. Health colours come from
`Tokens.swift`, never ad hoc.
