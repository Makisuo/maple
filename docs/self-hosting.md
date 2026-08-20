# Self-hosting Maple (Docker Compose)

A full Maple deployment outside Cloudflare — no Tinybird, no managed platform.
Telemetry lives in vanilla ClickHouse; the control plane (orgs, users, ingest
keys, dashboards, alerts) lives in Postgres, with ElectricSQL streaming
control-plane tables to the web app.

The catch is that `apps/api`, `apps/alerting`, and `apps/electric-sync` are
Cloudflare Workers — there is no plain-HTTP entry point. This stack runs their
Wrangler bundles under [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare)
(the same `workerd` runtime Cloudflare runs at the edge) in a single container,
with Miniflare emulating the KV, Durable Object, Queue, Workflow, and Hyperdrive
bindings the workers use. See [`deploy/workerd/`](../deploy/workerd/).

> **Runtime note.** Miniflare is the pragmatic choice today. Longer term this
> could move to [celld](https://github.com/denoland/celld) for a
> production-tuned Workers/Durable-Objects runtime; at the time of writing celld
> can't yet run the api (no TCP/Hyperdrive→Postgres, no cron/`scheduled`, no
> KV/Queues), so Miniflare is the working path until those land.

## Architecture

```
apps ──OTLP──▶ collector ──▶ ClickHouse                (telemetry)
                                 ▲
                                 │ SELECT (HTTP)
browser ──▶ proxy :3471 ──┬──▶ workerd (Miniflare)     /api  → api worker  :3472
                          │       ├─ Hyperdrive ──▶ Postgres   (control plane)
                          │       └─ /sync → electric-sync worker :3476
                          │                    ▲
                          │            Electric │ shapes ◀── Postgres WAL
                          └──▶ web (SPA)         /*
```

- **postgres** — control-plane DB. `wal_level=logical` so Electric can tail it.
- **electric** — serves per-table shapes from the WAL; internal only, fronted by
  the electric-sync worker which authenticates and org-scopes every request.
- **clickhouse** — telemetry store.
- **ch-migrate** — one-shot; applies the ClickHouse schema (the CLI baked into
  the workerd image), then exits. Idempotent.
- **collector** — Maple's prebuilt OTel collector; `mapleexporter` writes
  straight into ClickHouse base tables.
- **workerd** — api + alerting + electric-sync under one Miniflare process.
  Reaches Postgres via a Hyperdrive binding and runs the drizzle migrations
  (including the Electric publication) on boot.
- **web** — the SPA (nginx).
- **proxy** — a single-origin Caddy reverse proxy: `/api` → api worker,
  `/sync` → electric-sync worker, `/*` → SPA. The one port you expose.

## Quick start

```bash
cp .env.selfhost.example .env
# edit .env: set the passwords and generate the two ingest keys
openssl rand -base64 32   # → MAPLE_INGEST_KEY_ENCRYPTION_KEY
openssl rand -base64 32   # → MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY

docker compose -f docker-compose.selfhost.yml up -d --build
```

Then open <http://localhost:3471> and log in with `MAPLE_ROOT_PASSWORD`.

On first boot `ch-migrate` applies the ClickHouse schema and exits, then
`workerd` runs the Postgres drizzle migrations; the collector and web come up
once migrate completes.

## Configuration

See [`.env.selfhost.example`](../.env.selfhost.example). Required: the three
passwords (`MAPLE_ROOT_PASSWORD`, `MAPLE_POSTGRES_PASSWORD`,
`MAPLE_CLICKHOUSE_PASSWORD`) and the two ingest keys. Optional:
`OPENROUTER_API_KEY` (chat + AI triage — Workers AI is Cloudflare-only, so Maple
falls back to OpenRouter; leave unset to run everything else) and
`MAPLE_APP_BASE_URL` (your public origin).

`CLICKHOUSE_PROVIDER=clickhouse` is set in the compose — the api's `Env` defaults
to `tinybird`, and this is what keeps raw SQL on the vanilla-ClickHouse path.
`TINYBIRD_HOST` / `TINYBIRD_TOKEN` are pinned to dummy values: the `Env` schema
still parses them as required, but nothing reaches Tinybird with
`CLICKHOUSE_PROVIDER=clickhouse` and no per-org BYO row.

## Sending telemetry

Point your apps' OTLP exporter at the collector:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # or :4317 for gRPC
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

There is no ingest auth on the collector — keep it on a private network, or put
an authenticating proxy in front if it is internet-facing.

## Public deployment

`MAPLE_APP_BASE_URL` is baked into the SPA at build time (Vite), so if you serve
Maple from a real domain, set it and rebuild the web image:

```bash
MAPLE_APP_BASE_URL=https://maple.example.com \
  docker compose -f docker-compose.selfhost.yml up -d --build web
```

The bundled Caddy proxy terminates plain HTTP on `:3471`. Behind a public domain,
either let Caddy manage TLS (give it your hostname) or terminate TLS at your own
ingress and forward to the proxy.

## Upgrades

Pull a new revision, rebuild, redeploy:

```bash
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

ClickHouse schema upgrades land via `ch-migrate`; Postgres drizzle migrations run
on `workerd` boot. Both are idempotent.
