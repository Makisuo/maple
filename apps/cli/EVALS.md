# Maple CLI & Observability API — Evaluation Suite

These evals verify that the observability API and CLI can find all the data
an agent or human operator needs when investigating the Superwall production
system. Each eval maps to a real investigation scenario.

Run all evals with:

```bash
export MAPLE_API_TOKEN=<your-api-key>
# Either against local API (http://localhost:3472) or prod (https://api.maple.dev)
```

---

## 1 · Service Discovery

### 1.1 List all active services

```bash
maple services list --since 6h
```

**Expect:** 10+ services including `subscriptions-api`, `dash-api`,
`openrev-integrations`, `consumer-stripe-v2`, `consumer-app-store-connect`,
`web-paywall-worker`, `api-v2`, `consumer-consumption-request`,
`consumer-google-play-to-or`, `artifacts-api`.
Each row shows throughput, error rate, P95 latency.

### 1.2 Service health deep-dive

```bash
maple services health subscriptions-api --since 6h
```

**Expect:** Throughput, error rate, P50/P95/P99 latency, Apdex score, top
errors list, recent traces, recent logs.

### 1.3 Service dependency map

```bash
maple services map --since 6h
```

**Expect:** Edges like `subscriptions-api → artifacts-api`,
`consumer-app-store-connect → artifacts-api`, `artifacts-api → config-api`.
Each edge shows call count, error count, error rate, avg/P95 latency.

### 1.4 Top operations per service

```bash
maple services top-ops consumer-stripe-v2 --metric count --since 6h --limit 10
```

**Expect:** Span names ranked by count: `processStripeV2`,
`handleStripeWebhookEvent`, `Stripe.getAccount`,
`StripeApiInstanceResolver.resolveStripeApi`, etc.

### 1.5 Top operations sorted by error rate

```bash
maple services top-ops subscriptions-api --metric error_rate --since 6h --limit 5
```

**Expect:** Operations sorted by error rate descending.

---

## 2 · Span-Level Trace Search

The core improvement: searching by span name queries the raw `traces` table
and returns the **matched span**, not root-span summaries.

### 2.1 Exact span name

```bash
maple traces search --span "AuthnV2Live.bearer" --since 6h --limit 5
```

**Expect:** All results show `spanName=AuthnV2Live.bearer`,
`serviceName=api-v2`. Previously returned random unrelated traces (bug).

### 2.2 Span name + service filter

```bash
maple traces search --span "processStripeV2" --service consumer-stripe-v2 --since 6h --limit 5
```

**Expect:** All results show `processStripeV2` in `consumer-stripe-v2`.

### 2.3 Span name with error filter

```bash
maple traces search --span "PublicApiKeyAuthn" --service subscriptions-api --errors-only --since 6h --limit 3
```

**Expect:** Only error spans for `PublicApiKeyAuthn`.

### 2.4 Substring span search (contains mode)

```bash
maple traces search --span "Stripe" --since 1h --limit 5
```

**Expect:** Spans like `Stripe.getSubcriber`,
`StripeApiInstanceResolver.resolveStripeApi`,
`Stripe.getSubscriptionStatusesFromSubscriber`.

### 2.5 Substring + errors: failed SQL queries

```bash
maple traces search --span "sql" --errors-only --since 6h --limit 5
```

**Expect:** `sql.execute` error spans (e.g. 30s ClickHouse timeouts in
`consumer-consumption-request`).

### 2.6 Span search with min duration

```bash
maple traces search --span "sql.execute" --min-duration 10000 --since 6h --limit 3
```

**Expect:** `sql.execute` spans with duration > 10 seconds.

---

## 3 · Attribute-Based Search

### 3.1 Search by applicationId

```bash
maple traces search --attr applicationId=16408 --since 6h --limit 3
```

**Expect:** Traces from multiple services (openrev-integrations, dash-api,
web-paywall-worker) that involve applicationId 16408.

### 3.2 Search by applicationId + error

```bash
maple traces search --attr applicationId=16408 --errors-only --since 6h --limit 3
```

**Expect:** Only error traces for that application.

### 3.3 Span + attribute combined

```bash
maple traces search --span "Stripe" --attr applicationId=16408 --since 6h --limit 3
```

**Expect:** Stripe-related spans (e.g. `Stripe.getSubcriber`) that have
`applicationId=16408` as an attribute.

### 3.4 Search by deviceId

```bash
# First discover a recent deviceId:
maple attributes values deviceId --since 1h --limit 3
# Then search for it:
maple traces search --attr deviceId=<value-from-above> --since 6h --limit 3
```

**Expect:** Traces for that specific device.

---

## 4 · Trace Inspection

### 4.1 Inspect multi-service trace

```bash
# Get a traceId from a Stripe checkout flow
maple traces search --span "getActiveEntitlementsAndHistory" --since 1h --limit 1 --json | jq -r '.traces[0].traceId'
# Then inspect
maple traces inspect <traceId>
```

**Expect:** Multi-span tree showing: HTTP handler → auth → entitlements →
Stripe API calls → SQL queries. Attributes visible on each span (applicationId,
deviceId, subscriber info, SQL queries).

### 4.2 Inspect webhook processing trace

```bash
maple traces search --span "webhook.svixv1.ingest" --since 1h --limit 1 --json | jq -r '.traces[0].traceId'
maple traces inspect <traceId>
```

**Expect:** Span tree: `POST /v1/webhooks/svix` → `webhook.svixv1.ingest` →
`handleWebhookIngestion` → integration-specific spans. Attributes include
`eventName`, `applicationId`, `projectId`, `integration.id`.

### 4.3 Inspect auth failure trace

```bash
maple traces search --span "AuthnV2Live.bearer" --errors-only --since 6h --limit 1 --json | jq -r '.traces[0].traceId'
maple traces inspect <traceId>
```

**Expect:** Shows auth attempt chain: `AuthnV2Live.bearer` [Error] →
`AuthnV2Live.cookie` [Error] → `AuthnV2Live.oauth` [Ok], with error
messages like "Invalid API key format" and "Session is invalid or expired".

---

## 5 · Error Investigation

### 5.1 List all error types

```bash
maple errors list --since 6h --limit 10
```

**Expect:** Error types with counts, affected service count, last seen.

### 5.2 Errors filtered by service

```bash
maple errors list --service consumer-app-store-connect --since 6h --limit 5
```

**Expect:** Only errors from that service (e.g. "An error has occurred",
"Failed to execute statement").

### 5.3 Error detail with sample traces

```bash
maple errors detail "An error has occurred" --since 6h --limit 2
```

**Expect:** Sample traces showing root span, duration, services, error
message, and correlated logs.

### 5.4 Error detail with trend

```bash
maple errors detail "An error has occurred" --since 6h --trend --limit 2
```

**Expect:** Same as 5.3 plus an "Error Trend" section showing counts per
time bucket.

---

## 6 · Analytics: Breakdown

### 6.1 Error rate breakdown by service

```bash
maple breakdown --metric error_rate --group-by service --since 6h --limit 10
```

**Expect:** Services ranked by error rate. `api-v2` and `artifacts-api` near
the top.

### 6.2 P95 latency breakdown by span name

```bash
maple breakdown --metric p95_duration --group-by span_name --service subscriptions-api --since 6h --limit 5
```

**Expect:** Span names ranked by P95 latency (e.g. `PublicApiKeyAuthn`,
`http.client GET`, `sql.execute`).

### 6.3 Count breakdown by span name for Stripe consumer

```bash
maple breakdown --metric count --group-by span_name --service consumer-stripe-v2 --since 6h --limit 5
```

**Expect:** `processStripeV2` and `handleStripeWebhookEvent` at the top.

### 6.4 Breakdown with attribute filter

```bash
maple breakdown --metric count --group-by span_name --attr applicationId=16408 --since 6h --limit 5
```

**Expect:** Top span names for that specific application.

---

## 7 · Analytics: Timeseries

### 7.1 Error rate over time for a service

```bash
maple timeseries --metric error_rate --service consumer-app-store-connect --since 6h
```

**Expect:** Time-bucketed error rate (15-minute buckets), showing ~4-8% error
rate pattern.

### 7.2 Request count over time by service

```bash
maple timeseries --metric count --group-by service --since 6h
```

**Expect:** Multi-series output with all services, subscriptions-api
dominating at ~350K-400K per bucket.

### 7.3 Count over time for specific application

```bash
maple timeseries --metric count --attr applicationId=16408 --since 6h
```

**Expect:** Time-bucketed counts for that application.

### 7.4 P95 latency over time

```bash
maple timeseries --metric p95_duration --service subscriptions-api --since 6h
```

**Expect:** Latency trend, typically 200-300ms range.

---

## 8 · Log Search

### 8.1 Error logs for a service

```bash
maple logs search --service consumer-google-play-to-or --severity ERROR --since 6h --limit 5
```

**Expect:** Error log entries with timestamps, bodies containing error
details like "originalAppUserId is required".

### 8.2 Logs for a specific trace

```bash
maple logs search --trace-id <traceId> --since 6h --limit 10
```

**Expect:** All log entries associated with that trace.

### 8.3 Log text search

```bash
maple logs search --service subscriptions-api --query "publicApiKey" --since 1h --limit 5
```

**Expect:** Logs containing "publicApiKey" in the body.

---

## 9 · Attribute Discovery

### 9.1 Span attribute keys

```bash
maple attributes keys --source traces --scope span --since 6h --limit 15
```

**Expect:** Keys including `applicationId`, `appUserId`, `deviceId`,
`http.route`, `url.path`, `http.response.status_code`.

### 9.2 Resource attribute keys

```bash
maple attributes keys --source traces --scope resource --since 6h --limit 10
```

**Expect:** Keys including `maple_org_id`, `service.name`,
`deployment.environment`, `deployment.commit_sha`.

### 9.3 Values for a specific attribute

```bash
maple attributes values applicationId --since 6h --limit 10
```

**Expect:** Top applicationId values with usage counts.

### 9.4 Values for event types (Stripe)

```bash
maple attributes values eventType --since 6h --limit 10
```

**Expect:** Stripe event types: `invoice.payment_succeeded`,
`customer.subscription.updated`, `charge.succeeded`, etc.

---

## 10 · Period Comparison

### 10.1 Compare around a specific time

```bash
maple compare --around "2026-03-31 09:00:00"
```

**Expect:** Before vs after comparison showing throughput, error rate, error
count changes. Per-service breakdown with regression flags
(`error_rate_up`, `latency_up`, `throughput_drop`).

### 10.2 Compare with service filter

```bash
maple compare --around "2026-03-31 09:00:00" --service subscriptions-api
```

**Expect:** Comparison scoped to subscriptions-api only.

---

## 11 · Slow Trace Investigation

### 11.1 Find slowest traces

```bash
maple traces slow --service consumer-consumption-request --since 6h --limit 3
```

**Expect:** Shows percentile context (P50, P95, min, max) plus the top 3
slowest traces. consumer-consumption-request has 30s SQL timeouts.

### 11.2 Slow span-level search

```bash
maple traces search --span "sql.execute" --min-duration 10000 --since 6h --limit 3
```

**Expect:** Individual `sql.execute` spans > 10 seconds.

---

## 12 · JSON Output for Agent Piping

All commands support `--json` for machine-readable output.

### 12.1 Services as JSON

```bash
maple services list --since 1h --json | jq '.services[].name'
```

**Expect:** Array of service name strings.

### 12.2 Traces as JSON

```bash
maple traces search --span "AuthnV2Live.bearer" --since 1h --limit 3 --json | jq '.traces[].traceId'
```

**Expect:** Array of trace ID strings.

### 12.3 Chained investigation

```bash
# Find a trace, then inspect it
TID=$(maple traces search --span "processStripeV2" --since 1h --limit 1 --json | jq -r '.traces[0].traceId')
maple traces inspect "$TID"
```

**Expect:** Full span tree for the found trace.

---

## 13 · Business-Specific Scenarios

### 13.1 Stripe webhook processing

```bash
maple traces search --span "handleStripeWebhookEvent" --service consumer-stripe-v2 --since 6h --limit 3
```

**Expect:** Stripe webhook handler spans with attributes: `applicationId`,
`stripeEventId`, `stripeEventType`.

### 13.2 Code redemption flow

```bash
maple traces search --span "Redeemer.claim" --since 6h --limit 3
```

**Expect:** `Redeemer.claim` spans in `subscriptions-api`.

### 13.3 Entitlement checks

```bash
maple traces search --span "getActiveEntitlementsAndHistory" --service subscriptions-api --since 1h --limit 3
```

**Expect:** Entitlement check spans with duration info.

### 13.4 Open Revenue webhook integrations

```bash
maple traces search --span "webhook.svixv1.ingest" --since 1h --limit 3
```

**Expect:** Webhook ingestion spans in `openrev-integrations` with
attributes: `eventName`, `applicationId`, `projectId`.

### 13.5 Org resolution

```bash
maple traces search --span "OrgResolver.fromApplication" --since 1h --limit 3
```

**Expect:** Org resolution spans in `api-v2` with `applicationId` and
`scope` attributes.

### 13.6 Artifact resolution errors

```bash
maple traces search --span "Resolver" --errors-only --since 6h --limit 5
```

**Expect:** `ConfigArtifactResolver.resolveArtifact` error spans in
`artifacts-api`.

---

## Known Gaps

1. **Multi-attribute filter on trace search**: Only the first `--attr` is
   used. The CLI warns when multiple are provided and suggests using
   `breakdown` or `timeseries` which support multiple attribute filters.

2. **Attribute counts show 0**: The `attributes keys` and
   `attributes values` commands return the correct keys/values but counts
   show as 0. This is a Tinybird pipe output field naming issue
   (`usageCount` vs `count`).

3. **Service-scoped attribute discovery**: `attributes keys --service X`
   returns global attribute keys, not scoped to the service. The underlying
   Tinybird pipe doesn't filter by service for attribute key discovery.
