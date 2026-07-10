# Railway integration (internal architecture)

Customer-facing docs: `apps/landing/src/content/docs/integrations/railway.md`. This page is the
operator/contributor map of how the integration works.

## Why pull-based

Railway has no log drain and no webhook for logs; the only programmatic access is the public
GraphQL API (`https://backboard.railway.com/graphql/v2`, WebSocket subscriptions on the same host).
So Maple pulls: the org pastes a workspace/account token, and a Maple-run connector streams logs
and polls metrics with it.

## Pieces

| Piece | Where | Role |
| --- | --- | --- |
| `railway_connections` / `railway_targets` | `packages/db/src/schema/railway.ts` | One AES-256-GCM-encrypted token per org; one row per ingested (project, environment) with health + watermark columns. |
| `RailwayIntegrationService` | `apps/api/src/services/RailwayIntegrationService.ts` | Connect (validate via `me`, falling back to the projects query for workspace tokens), discovery, target CRUD, the internal work list, result/watermark recording. |
| Public routes | `apps/api/src/routes/railway.http.ts` | `/api/railway/*` (MapleApi `railway` group). Mutations are admin-gated. |
| Internal routes | `apps/api/src/routes/railway-internal.http.ts` | `GET /api/internal/railway-targets` + `POST /api/internal/railway-results`, authenticated with `SD_INTERNAL_TOKEN` (same trust as scraper-internal). Decrypted tokens and org `maple_pk_*` ingest keys ride ONLY this wire. |
| Connector | `apps/railway-connector/` | Standalone Bun/Effect process (clone of `apps/scraper`'s scheduler shape). One `environmentLogs` graphql-transport-ws subscription per target + one metrics poll loop per (target, service). Pushes OTLP/JSON to the ingest gateway with the org's public key → billed + warehouse-routed like customer OTLP. **No changes to `apps/ingest` or `apps/alerting`.** |
| UI | `apps/web/src/components/integrations/railway-integration-card.tsx` | Paste-token connect, environment picker, per-target health. |

## Data mapping

- Logs: `service.name` = Railway service name (resolved from the environment's cached service
  list; unknown ids degrade to `railway:<id>`, environment-level lines to
  `railway-environment:<env>`), severity string → OTLP severityNumber, `railway.deployment.id` +
  Railway's structured attributes as log attributes.
- Metrics: gauges `railway.cpu.usage/limit` ({cpu}), `railway.memory.usage/limit`,
  `railway.disk.usage`, `railway.network.rx/tx` (bytes; GB values scaled ×1e9). Land in the
  existing `metrics_gauge` datasource — no Tinybird changes.
- Both carry `cloud.provider=railway`, `railway.project/environment/service` ids+names,
  `service.namespace` = project name. The gateway stamps `maple_org_id` itself.

## Operational notes

- **Single replica.** The connector has no lease coordination — two replicas would double-ingest
  every log line. Keep the Railway service at 1 replica; add a lease column (see
  `cloudflare_analytics_state.leaseUntil`) if HA is ever needed.
- **Rate limits are the customer's** (100/1,000/10,000 requests/hour by plan, not queryable).
  Poll delays honor `X-RateLimit-Remaining` (4× stretch under 25 remaining) and `Retry-After`
  (exponential backoff, 15 min cap). See `nextPollDelayMs` in
  `apps/railway-connector/src/RailwayGraphql.ts`.
- **Watermarks**: the api advances `log_watermark_at`/`metrics_watermark_at` monotonically from
  result reports. Log reconnects dedupe against the watermark; gaps during a disconnect are lossy
  (documented) — metrics backfill up to 1 h.
- **Token revocation**: any Railway 401 (poll or subscription) reports `unauthorized: true`; the
  api stamps `last_validation_error` on the connection and the card shows "Reconnect needed".
- **Billing**: pushes go through the ingest gateway with the org's public key, so Autumn metering
  and 402 limits apply. The connector drops log batches on 402 instead of retrying forever.
- Deploy: new Railway service in Maple's own project — config file
  `apps/railway-connector/railway.json`, root directory at the repo root, env `MAPLE_API_URL`,
  `SD_INTERNAL_TOKEN`, `MAPLE_INGEST_URL` (+ optional `RAILWAY_CONNECTOR_*`, `PORT`, default 3476).

## v1 boundaries (deliberate)

- Workspace/account tokens only (project tokens use a different header and can't enumerate).
- Runtime logs only — no build/deploy logs, no HTTP edge logs.
- One Railway connection per org (unique index; relax later if needed).
- The `environmentLogs` subscription shape was written against Railway's public schema as used by
  community egress tools; if Railway's schema drifts, the tolerant decoders drop what they can't
  parse and target health surfaces the errors.
