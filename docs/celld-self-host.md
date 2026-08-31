# Maple Cloud on celld (self-host)

> **Proof of concept.** This is an experiment in running Maple Cloud on
> [celld](https://celld.dev) so a VPS self-host does not need a Cloudflare
> account. It is not the official production deploy. Hosted Maple still uses
> Alchemy / Workers; telemetry-only installs should keep using local-mode
> `maple start`.

Run Maple **Cloud** (the Workers API + web UI, not local-mode `maple start`) on
your own machine or VPS **without Cloudflare Workers, wrangler, Miniflare, or a
Cloudflare account**.

This is slice-2: **web UI + API + electric-sync + alerting** talking to
**docker Postgres + ClickHouse**, with self-hosted password auth and interactive
Postgres transactions. It is not a rewrite of the hosted Cloud stack.

## Why celld

[celld](https://celld.dev) is a self-hosted runtime for Cloudflare Workers and
Durable Objects. Maple's API is a Worker. celld v0.4.0 runs that Worker from a
stripped Wrangler config (`apps/api/wrangler.celld.jsonc`) so we keep one
codepath instead of a second Node server.

Install docs: [celld.dev](https://celld.dev) · source:
[github.com/denoland/celld](https://github.com/denoland/celld).

## One-command local start

From the repo root, with `.env.local` already filled (see
[Required env](#required-env)):

```bash
bash scripts/celld-dev.sh
```

That script:

1. Ensures docker Postgres (`:5499`), Electric (`:3473`), and ClickHouse (`:8123`)
   are up (`bun db:up`, `bun ch:up`), applies Postgres migrations, then applies
   the ClickHouse schema (`packages/clickhouse-cli`). It does **not** stop
   unrelated stacks. CH apply is idempotent; it fails the start only on a real
   error, not when the schema is already current.
2. Starts `scripts/pg-ws-proxy.ts` on `:5498` (Neon-compatible WebSocket ↔ TCP
   tunnel onto Postgres, plus `POST /sql` for tests).
3. Installs celld **v0.4.0** into `.tools/celld` if needed (macOS arm64 gzip from
   GitHub releases).
4. Runs **three** `celld dev` processes (one public Worker each; never the same
   fleet / `deploy/current.json`):
    - `apps/api` on **`:3472`**
    - `apps/electric-sync` on **`:3476`** (web `VITE_ELECTRIC_SYNC_URL`)
    - `apps/alerting` on **`:8788`** (scheduled-only; `fetch` is 404)
5. Starts Vite `apps/web` on `:3471` against that API (`START_WEB=0` to skip).
   Reuses an already-running Vite rather than fighting it.

Health:

```bash
curl -sS http://127.0.0.1:3472/health
# OK
curl -sS http://127.0.0.1:3472/.well-known/celld/health
```

Sign in at `http://127.0.0.1:3471` with `MAPLE_AUTH_MODE=self_hosted` and
`MAPLE_ROOT_PASSWORD` from `.env.local` (docs examples use `change-me`). Login
itself is HMAC JWT and does **not** hit Postgres. A control-plane route such as
`GET /v2/dashboards` does. Interactive transactions (alert-rule create, API-key
roll, share rotate) go through `@neondatabase/serverless` over the WS proxy.

```bash
TOKEN=$(curl -sS http://127.0.0.1:3472/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"change-me"}' | jq -r .token)
curl -sS http://127.0.0.1:3472/v2/dashboards \
  -H "authorization: Bearer $TOKEN"
curl -sS http://127.0.0.1:3472/v2/dashboards \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"celld-test"}'
curl -sS http://127.0.0.1:3472/v2/alerts/rules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"celld-test","severity":"critical","signal_type":"error_rate","comparator":"gt","threshold":0.05,"window_minutes":5,"destination_ids":[]}'
curl -sS -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3476/api/sync/shape?shape=dashboards'
```

Local celld state lives in each app's `.celld/dev` (`apps/api`,
`apps/electric-sync`, `apps/alerting`). Add `.celld/` to gitignore (already done
at the repo root).

## Ports

| Port | Process                       | Notes                                                                        |
| ---- | ----------------------------- | ---------------------------------------------------------------------------- |
| 3472 | celld (`maple-api`)           | Default; wrangler used the same port                                         |
| 3476 | celld (`maple-electric-sync`) | Own `.celld/dev`. Web `VITE_ELECTRIC_SYNC_URL`                               |
| 8788 | celld (`maple-alerting`)      | Own `.celld/dev`. `fetch` is 404 "scheduled only"                            |
| 3471 | Vite `apps/web`               | Slice-1 UI. celld assets are optional later                                  |
| 5499 | docker Postgres               | Logical URL host for `MAPLE_PG_URL`                                          |
| 5498 | `pg-ws-proxy`                 | Neon `/v1` WS pipe + `POST /sql` (tests only). celld cannot TCP-dial `:5499` |
| 8123 | docker ClickHouse HTTP        | Schema applied by `clickhouse-cli` during `dev:celld`                        |
| 3473 | docker Electric               | Upstream for `apps/electric-sync` (`ELECTRIC_URL`)                           |
| 9876 | celld default                 | Unused here; we pass `--port` per process                                    |

celld itself answers `GET /.well-known/celld/health` (moved in v0.4).

Shape `503` with `missing from the publication "electric_publication_default"`
means drizzle recorded `0009_electric_publication` while the `WHEN OTHERS`
guard swallowed `CREATE PUBLICATION` (see [electric-sync.md](./electric-sync.md)
Troubleshooting). `dev:celld` now heals membership after migrate. To repair a
live volume without restarting: add the six shape tables to that publication
and restart `maple-electric-1`.

The browser HTTP/1.1 “~6 concurrent connections” warning is expected on local
HTTP (no HTTP/2). It is not the 503.

## Required env

`.env.local` (never committed). The start script copies a whitelist into
`.tools/celld-vars.env` and points celld at it with `CELLD_VARS_FILE`.

Must be set (Env dies without them; `/health` still 200, everything else 504):

- `TINYBIRD_HOST` / `TINYBIRD_TOKEN` — placeholders are fine in slice-1
- `MAPLE_INGEST_KEY_ENCRYPTION_KEY` — base64 of 32 bytes
- `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`
- `MAPLE_ROOT_PASSWORD`
- `MAPLE_AUTH_MODE=self_hosted`
- `MAPLE_DEFAULT_ORG_ID` (default `default`)

The script always overlays:

- `MAPLE_PG_URL=postgres://maple:maple@127.0.0.1:5499/maple`
- `MAPLE_PG_WS_PROXY=ws://127.0.0.1:5498`
- `CLICKHOUSE_URL=http://127.0.0.1:8123`
- `CLICKHOUSE_PROVIDER=clickhouse`
- `ELECTRIC_URL=http://127.0.0.1:3473`
- `MAPLE_ALERTING_ALLOW_NONPROD=1`

**Do not overload `MAPLE_DB_URL`.** That variable is the PGlite data directory
(`packages/db/src/config.ts`), not a Postgres URL.

`MAPLE_DB` remains a Hyperdrive **object** on Cloudflare. A string `MAPLE_DB`
is still Unavailable on purpose. celld uses `MAPLE_PG_URL` instead.

## What is stubbed / omitted in slice-2

celld v0.4.0 accepted wrangler keys: `$schema`, `name`, `main`, `no_bundle`,
`compatibility_date`, `compatibility_flags`, `durable_objects`, `migrations`,
`assets`, `services`, `triggers`, `vars`, `d1_databases`, `kv_namespaces`,
`queues`, `workflows`, `r2_buckets`.

Forbidden (they stop deploy): `hyperdrive`, `ai`, `ratelimits`, `send_email`,
`routes`, `dev`, `workers_dev`.

| Binding / feature                                   | Slice-2                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hyperdrive `MAPLE_DB`                               | Absent. Fallback: `MAPLE_PG_URL` + neon-serverless over WS proxy                                                                                                                |
| TCP `connect()` / `cloudflare:sockets` / `node:net` | Inert stub. Postgres goes through WebSockets                                                                                                                                    |
| EMAIL (`send_email`)                                | Missing → EmailService skips / errors as today                                                                                                                                  |
| `API_V2_RATE_LIMITER`                               | Missing → fail-open                                                                                                                                                             |
| Workers AI                                          | Missing. LLM stays on OpenRouter HTTP when configured                                                                                                                           |
| Queues (VCS sync, PlanetScale webhooks)             | Omitted. celld refuses a queue consumer on a Worker that also exports `fetch`                                                                                                   |
| Workflows / ChatSession DO / MCP KV                 | Declared with accepted keys; Partial in celld                                                                                                                                   |
| Cron                                                | Declared; Partial                                                                                                                                                               |
| Landing, AI triage, email, PlanetScale, VCS sync    | Out of slice-2                                                                                                                                                                  |
| `apps/electric-sync`                                | Second `celld dev` on `:3476`. DB-free HTTP proxy to docker Electric                                                                                                            |
| Web on celld                                        | Config exists (`apps/web/wrangler.celld.jsonc`); local still uses Vite. Do not `celld deploy` web onto the same local fleet as the API — last deploy owns `deploy/current.json` |
| Alerting worker                                     | Third `celld dev` on `:8788`. Same `MAPLE_PG_URL` + WS proxy as api. `fetch` 404; crons Partial in celld                                                                        |

The existing Hyperdrive path is unchanged: wrangler / alchemy still bind
`MAPLE_DB` as an object, and that branch wins over `MAPLE_PG_URL`.

## Postgres without TCP

celld cannot dial `127.0.0.1:5499`. Host-side `scripts/pg-ws-proxy.ts` (Bun)
listens on `127.0.0.1:5498` and copies binary WebSocket frames to Postgres TCP.

Inside the Worker, `createMaplePgSocket` sees `MAPLE_PG_WS_PROXY` and uses
`@neondatabase/serverless` + `drizzle-orm/neon-serverless` through a Neon
`/v1?address=host:port` WebSocket pipe (`neonConfig.webSocketConstructor =
WebSocket`, `useSecureWebSocket = false`, `pipelineConnect = false`). The Pool
is request-scoped (created in the connection scope, `end()` on close) because
celld closes outbound WebSockets after the response. workerd postgres.js can
copy bytes through a raw WebSocket tunnel, but SCRAM against real Postgres
fails (`malformed SCRAM message`) — do not retry that as the primary path.
Unset `MAPLE_PG_WS_PROXY` keeps today's TCP postgres.js path for wrangler and
Hyperdrive.

`POST /sql` on the same proxy is tests/fallback only (drizzle-orm/pg-proxy cannot
`db.transaction()`). The unpathed WebSocket remains a raw byte tunnel for tests
(`packages/db/src/pg-ws-socket.ts`).

Official `ghcr.io/neondatabase/wsproxy` is an alternative on a **different**
loopback port (`MAPLE_PG_WS_PROXY` pointed there). On macOS/OrbStack,
`--network host` may not work; prefer `-p` + `host.docker.internal:5499` in
`ALLOW_ADDR_REGEX`.

SSL through the tunnel is not in this slice (local docker is unencrypted).

## Production packaging

Dev (`bash scripts/celld-dev.sh`) is the compatibility experiment. Production files live in
[`deploy/celld-self-host/`](../deploy/celld-self-host/) (Caddy, Compose, Kustomize).
Alchemy is **not** used. Workers use `apps/*/wrangler.celld.jsonc`.

**Prod data is never the dev data plane.** `bash scripts/celld-dev.sh` uses compose
project `maple` volumes (`maple_postgres-data`, `maple_clickhouse-data`) and
`apps/*/.celld/dev`. Production Compose uses project `maple-celld-selfhost`
(own Postgres/ClickHouse/MinIO volumes) and `celld deploy` into S3 prefixes,
not `celld dev`. Host Caddy in front of `:3472` is only an ingress check; it
still reads the **dev** stores until you run the Compose/K8s recipes.

**S3 is on by default.** The stock compose/k8s start MinIO
(`s3://maple-celld/{api,sync,alerting}`). Already have S3 or Postgres? **Copy**
`deploy/celld-self-host/`, delete those services (and `depends_on` / `k8s/minio.yaml`),
and put your URLs in `.env`.

Verify in this order: **host Caddy (ingress)** → **Compose (real prod data)** → **K8s**.

### Host (single origin in front of a running celld)

With api `:3472`, electric-sync `:3476`, and a production SPA build:

```bash
VITE_MAPLE_AUTH_MODE=self_hosted VITE_API_BASE_URL= VITE_ELECTRIC_SYNC_URL= \
  bun run --cwd apps/web build
caddy run --config deploy/celld-self-host/Caddyfile.host --adapter caddyfile
```

Open http://127.0.0.1:8080 — password is `MAPLE_ROOT_PASSWORD`. Caddy proxies
`/v2` `/api` `/health` to api, `/api/sync` to electric-sync, and serves `apps/web/dist`.

Same-origin only works after a production build with empty `VITE_*` URLs. The SPA
resolves the Electric shape proxy to `location.origin/api/sync/shape` at runtime
(`ShapeStream` cannot take a relative URL). Vite on `:3471` still bakes
`localhost:3472` into the bundle.

### Compose (this is the product)

```bash
cd deploy/celld-self-host
cp env.example .env
# set MAPLE_ROOT_PASSWORD and the two MAPLE_INGEST_KEY_* secrets
docker compose --env-file .env up --build
```

Open http://127.0.0.1:8080 (password = `MAPLE_ROOT_PASSWORD`). OTLP HTTP is `/v1/traces`
on that origin; OTLP gRPC is `:4317`.

Already have Postgres or S3? Copy this folder, delete the `postgres` / `minio`
(and `minio-init`) services plus their `depends_on`, then in `.env`:

```
MAPLE_PG_URL=postgres://user:pass@db.internal:5432/maple
MAPLE_PG_WS_ALLOW=db.internal
S3_ENDPOINT=https://s3.amazonaws.com
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
CELLD_S3_BUCKET=your-bucket
```

First boot still needs Drizzle migrate + ClickHouse schema + Electric publication
against those URLs (same heal as `dev:celld`).

### Kubernetes

```bash
kubectl apply -k deploy/celld-self-host/k8s
```

Point ConfigMap/Secret `MAPLE_PG_URL` / `CLICKHOUSE_URL` / `ELECTRIC_URL` at existing
cluster services. Images: `maple-celld:dev`, `maple-web:dev`, `maple-pg-ws-proxy:dev`.

### Layout

```
deploy/celld-self-host/
  Caddyfile            # docker service names
  Caddyfile.host       # 127.0.0.1 backends + apps/web/dist
  compose.yml
  env.example
  docker/
  k8s/
```

### Images

`Dockerfile.celld` is a production graph, not a copy of the monorepo:

1. `turbo prune @maple/api @maple/alerting @maple/electric-sync @maple/clickhouse-cli`
2. strip root tooling (`oxlint` / `alchemy` / `knip`)
3. build `clickhouse-builder` + `effect-sdk` `dist/`
4. `bun install --production` (no wrangler / workerd / vitest)
5. slim runtime: `oven/bun:1.4.0-slim` + celld + esbuild

Migrate uses `bun run --cwd packages/db db:migrate:pg` (`drizzle-orm` migrator),
not `drizzle-kit`, so the runtime image does not need that devDependency.

Measured on arm64 (one image; api/sync/alerting share layers):

| Image                         | Approx                                                   |
| ----------------------------- | -------------------------------------------------------- |
| `maple-celld`                 | 559 MB (was 3.35 GB with a full-workspace `bun install`) |
| `maple-web`                   | 75 MB                                                    |
| `maple-pg-ws-proxy`           | 185 MB (`bun` slim base)                                 |
| `maple-otel`                  | 29 MB                                                    |
| ClickHouse / Electric / Caddy | upstream                                                 |

## VPS notes

A VPS bring-up is the data plane plus one celld process per public Worker:

1. **docker data plane** — Postgres (logical replication for Electric),
   ClickHouse HTTP `:8123` (apply schema with `clickhouse-cli`).
2. **`pg-ws-proxy`** on loopback, targeting docker Postgres. Do not publish
   `:5498` or `:5499` past localhost.
3. **three celld processes** — `maple-api`, `maple-electric-sync`, `maple-alerting`.
   One `celld` process = one public Worker; do not `celld deploy` them onto the
   same fleet. Locally that is three `celld dev` invocations from three app
   directories (separate `.celld/dev`). Terminate TLS on the ingress proxy;
   celld does not.

Put `CELLD_VARS_FILE` next to the node (or `CELLD_VAR_*`); process env wins over
wrangler `vars`. Never commit secrets.
