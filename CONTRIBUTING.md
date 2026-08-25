# Contributing to Maple

This guide covers local development for the full Maple stack: app services, Postgres,
ClickHouse, and the OTel collector pipeline.

For a single-binary experience without Docker, see [docs/local-mode.md](docs/local-mode.md)
(`maple start`).

## Prerequisites

Install the pinned toolchain (recommended via [mise](https://mise.en.dev)):

| Tool   | Used for                             |
| ------ | ------------------------------------ |
| Bun    | JS/TS apps, scripts, tests           |
| Node   | Some scripts (e.g. mobile)           |
| Rust   | `apps/ingest` (OTLP gateway)         |
| Docker | Postgres, ClickHouse, OTel collector |

First-time bootstrap:

```bash
curl https://mise.run | sh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc   # or bash/fish equivalent
mise trust
mise run setup   # installs tools, bun deps, copies .env.example → .env.local, portless CA
```

Without mise, the same steps manually:

```bash
bun install
cp .env.example .env.local
npx portless trust   # only needed if you use `bun dev` / portless HTTPS URLs
```

## Architecture (local dev)

```text
Browser → web (3471) → api (3472) → ClickHouse (8123)
                              ↓
OTLP clients → ingest (3473/3474) → OTel collector (4318) → ClickHouse
                              ↓
                         Postgres (5499)   app state (issues, keys, dashboards, …)
```

The development Docker stack (`docker-compose.development.yml`) runs the data plane.
Application processes run on the host (see [Running application services](#running-application-services)).

## Environment file

All services read secrets and overrides from **`.env.local`** at the repo root (gitignored).
Start from the template:

```bash
cp .env.example .env.local
```

### Generate required secrets

Several services share these keys. Generate them once and paste into `.env.local`:

```bash
# AES-256-GCM key for encrypting private ingest keys at rest (must be base64 of exactly 32 bytes)
openssl rand -base64 32

# HMAC key for ingest-key lookup hashes (any non-empty secret; hex is convenient)
openssl rand -hex 32
```

Set the outputs as:

```dotenv
MAPLE_INGEST_KEY_ENCRYPTION_KEY=<output of first command>
MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY=<output of second command>
```

### Recommended baseline for ClickHouse local dev

These values align with `docker-compose.development.yml` and self-hosted auth:

```dotenv
# Warehouse — route API queries to local ClickHouse instead of Tinybird Cloud
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_PROVIDER=clickhouse
CLICKHOUSE_USER=maple
CLICKHOUSE_PASSWORD=maple
CLICKHOUSE_DATABASE=default

# App database (wrangler dev uses Hyperdrive → docker Postgres on 5499)
# MAPLE_DB_URL is intentionally blank for wrangler; see db:migrate:local below.

# Auth — self-hosted mode (no Clerk account required)
MAPLE_AUTH_MODE=self_hosted
MAPLE_ROOT_PASSWORD=change-me
MAPLE_DEFAULT_ORG_ID=default

# Ingest — forward OTLP to the local collector (which writes ClickHouse)
INGEST_WRITE_MODE=forward
INGEST_FORWARD_OTLP_ENDPOINT=http://127.0.0.1:4318
INGEST_PORT=3474

# Single-tenant ingest keys (no Postgres key store required)
MAPLE_SELF_HOSTED_MODE=single_tenant
MAPLE_ORG_ID_OVERRIDE=default

# Internal service auth (must match across api and scraper)
INTERNAL_SERVICE_TOKEN=dev-internal-service-token
SD_INTERNAL_TOKEN=dev-internal-service-token

# Web → API/ingest URLs when running raw ports (not portless)
VITE_API_BASE_URL=http://localhost:3472
VITE_MAPLE_AUTH_MODE=self_hosted
```

`TINYBIRD_HOST` and `TINYBIRD_TOKEN` remain in `.env.example` because the API validates
them at startup even when `CLICKHOUSE_URL` is set. Placeholder values from the template are
fine for this stack.

> **Clerk mode:** set `MAPLE_AUTH_MODE=clerk` and provide `CLERK_SECRET_KEY`,
> `CLERK_PUBLISHABLE_KEY`, plus the matching `VITE_*` overrides. Test credentials for the
> hosted dev org are documented in [CLAUDE.md](CLAUDE.md).

## Start infrastructure (Docker)

From the repo root:

```bash
docker compose -f docker-compose.development.yml up -d
```

This starts:

| Service          | Ports                   | Purpose                                      |
| ---------------- | ----------------------- | -------------------------------------------- |
| `postgres`       | `5499 → 5432`           | App DB for `wrangler dev` (Hyperdrive local) |
| `clickhouse`     | `8123`, `9000`          | Telemetry warehouse                          |
| `otel-collector` | `4317`, `4318`, `13133` | OTLP ingest → ClickHouse via mapleexporter   |

The collector reads `.env.local` and uses `MAPLE_CLICKHOUSE_PASSWORD=maple` from compose
overrides. Ensure ClickHouse credentials in `.env.local` match (`maple` / `maple`).

Wait for health checks, then apply schema and migrations:

```bash
# Postgres (Drizzle migrations for app state)
bun run db:migrate:local

# ClickHouse (telemetry tables + materialized views)
bun run --cwd packages/clickhouse-cli start apply \
  --url=http://localhost:8123 \
  --user=maple \
  --password=maple \
  --database=default
```

Stop infrastructure:

```bash
docker compose -f docker-compose.development.yml down
```

Postgres data persists in the `postgres-data` volume; ClickHouse in `clickhouse-data`.
Remove volumes with `down -v` for a clean slate.

## Running application services

`development.mprocs.yaml` (local only, not committed) runs the core apps in one terminal
via [mprocs](https://github.com/pvolok/mprocs). Equivalent manual commands:

Open **one terminal per service** (order matters: start `api` before dependents).

### 1. API (`apps/api`)

```bash
cd apps/api && bun dev:app
```

Default URL: `http://localhost:3472`

| Variable                                                          | Required              | Notes                                                                                                |
| ----------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `MAPLE_INGEST_KEY_ENCRYPTION_KEY`                                 | yes                   | `openssl rand -base64 32`                                                                            |
| `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`                                | yes                   | `openssl rand -hex 32`                                                                               |
| `MAPLE_AUTH_MODE`                                                 | yes                   | `self_hosted` or `clerk`                                                                             |
| `MAPLE_ROOT_PASSWORD`                                             | yes\*                 | \*Required when `MAPLE_AUTH_MODE=self_hosted`                                                        |
| `MAPLE_DEFAULT_ORG_ID`                                            | yes                   | Default `default`; must match ingest org override                                                    |
| `TINYBIRD_HOST`                                                   | yes                   | Placeholder OK when using `CLICKHOUSE_URL`                                                           |
| `TINYBIRD_TOKEN`                                                  | yes                   | Placeholder OK when using `CLICKHOUSE_URL`                                                           |
| `TINYBIRD_SIGNING_KEY` / `TINYBIRD_WORKSPACE_ID`                  | with Tinybird raw SQL | Explicit JWT signing configuration; never derived from `TINYBIRD_TOKEN`                              |
| `TINYBIRD_RAW_SQL_JWT_RPS_LIMIT`                                  | optional              | Positive integer; Tinybird-enforced raw-SQL ceiling with a separate bucket per org                   |
| `CLICKHOUSE_URL`                                                  | recommended           | `http://localhost:8123` for local ClickHouse stack                                                   |
| `CLICKHOUSE_PROVIDER`                                             | optional              | `tinybird` (default) or `clickhouse`; set `clickhouse` for env-level vanilla/self-managed ClickHouse |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DATABASE` | with CH               | Match docker-compose (`maple` / `maple` / `default`)                                                 |
| `INTERNAL_SERVICE_TOKEN`                                          | recommended           | Internal MCP tool calls; shared with the scraper                                                     |
| `SD_INTERNAL_TOKEN`                                               | optional              | Prometheus scraper internal API auth                                                                 |
| `CLERK_*`                                                         | clerk mode            | See `.env.example`                                                                                   |

Loads env via `--env-file ../../.env.local` (wrangler). Requires docker Postgres running
(`bun run db:migrate:local`).

### 2. Web (`apps/web`)

```bash
cd apps/web && bun dev:app
```

Default URL: `http://localhost:3471`

| Variable                | Required   | Notes                                                         |
| ----------------------- | ---------- | ------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | yes        | `http://localhost:3472` (or portless `https://api.localhost`) |
| `VITE_MAPLE_AUTH_MODE`  | yes        | Mirror `MAPLE_AUTH_MODE`                                      |
| `VITE_INGEST_URL`       | optional   | Defaults derived; set if ingest port differs                  |
| `VITE_CLERK_*`          | clerk mode | Publishable key + sign-in URLs                                |
| `VITE_MAPLE_INGEST_KEY` | optional   | Browser self-telemetry via ingest                             |

Sign in (self-hosted): use the org/user you create with `MAPLE_ROOT_PASSWORD`.
Clerk dev login: see [CLAUDE.md](CLAUDE.md).

### 3. Ingest (`apps/ingest`)

```bash
cd apps/ingest && bun dev:app
```

Default port: `3473` (`INGEST_PORT` / `PORT` override). `.env.example` uses `3474`; pick one
port and keep `VITE_*` / `MAPLE_INGEST_PUBLIC_URL` consistent.

| Variable                           | Required       | Notes                                                                   |
| ---------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `INGEST_FORWARD_OTLP_ENDPOINT`     | yes            | `http://127.0.0.1:4318` for local collector                             |
| `INGEST_WRITE_MODE`                | recommended    | `forward` for ClickHouse stack (default `tinybird`)                     |
| `MAPLE_INTERNAL_ORG_ID`            | yes            | Org the gateway files its OWN telemetry under; no default               |
| `MAPLE_INGEST_KEY_ENCRYPTION_KEY`  | yes\*          | \*Required for postgres key store / ClickHouse direct path              |
| `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` | yes            | Same value as API                                                       |
| `MAPLE_SELF_HOSTED_MODE`           | recommended    | `single_tenant` → static key store (no DB)                              |
| `MAPLE_ORG_ID_OVERRIDE`            | with static    | Must match `MAPLE_DEFAULT_ORG_ID`                                       |
| `MAPLE_PG_URL`                     | postgres store | `postgres://maple:maple@localhost:5499/maple` if not using static store |
| `TINYBIRD_HOST` / `TINYBIRD_TOKEN` | tinybird mode  | When `INGEST_WRITE_MODE=tinybird` or `dual`                             |
| `TINYBIRD_MIRROR_HOST` / `_TOKEN`  | migration only | Mirrors writes into a second workspace; best-effort, set both or neither |
| `INGEST_PORT`                      | optional       | Default from port / env                                                 |
| `INGEST_REQUIRE_TLS`               | optional       | `false` locally                                                         |

Sources `../../.env.local` automatically. Requires Rust toolchain.

### 4. Scraper (`apps/scraper`)

Optional — polls the API for Prometheus targets and forwards metrics through ingest.

```bash
cd apps/scraper && bun dev
```

Default health port: `3475`

| Variable              | Required | Notes                                                         |
| --------------------- | -------- | ------------------------------------------------------------- |
| `MAPLE_API_URL`       | optional | Default `http://127.0.0.1:3472`                               |
| `MAPLE_INGEST_URL`    | optional | Default `http://127.0.0.1:3474`                               |
| `SD_INTERNAL_TOKEN`   | optional | Default `maple-sd-dev-token`; match API's `SD_INTERNAL_TOKEN` |
| `SCRAPER_CONCURRENCY` | optional | Default `10`                                                  |
| `PORT`                | optional | Health endpoint, default `3475`                               |

Loads `../../.env.local` via `bun --env-file`.

### 5. AI chat and triage (in `apps/api`)

`/chat` and `/investigations/*` are served by `apps/api` itself: the `ChatSession` Durable
Object owns each transcript and the agent turn runs in-process on `@opencode-ai/ai` against the
Workers AI `AI` binding. There is no second worker to start — but the chat routes only work
when `apps/api` is running **under wrangler** (`cd apps/api && bun dev:app`), because a plain
`bun` process has neither the Durable Object namespace nor the `AI` binding.

The `AI` binding needs a Cloudflare account with Workers AI (`wrangler login`). Confirm the
default model id in `apps/api/src/lib/Llm.ts` is still in the catalog — `bunx wrangler ai
models list`; a retired id returns `410`. Override it with `MAPLE_TRIAGE_MODEL`.

> **`MAPLE_ORG_ID_OVERRIDE` breaks the investigation chat.** It pins every API request to
> one org, but the browser addresses the session as `<clerk org>:<tab>`. With the
> override set to anything other than your Clerk organization's id, the page watches a
> session the API never seeded, and the transcript stays empty forever. Unset it,
> or set it to your Clerk org id, when working on chat.

When an autonomous investigation fails to start, the `investigations.error` column names it:

| `error` value                                                    | Cause                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `agent_unavailable: …`                                           | `apps/api` isn't running under wrangler, so there is no `CHAT_SESSION` binding |
| `start_failed: a turn is already running for this investigation` | The session is busy; retry                                                     |
| `diagnosis_timeout: …`                                           | The turn ran but never called `submit_diagnosis` within 15 minutes             |

### All-in-one alternatives

**Turbo + portless** (HTTPS `*.localhost` URLs, runs every app's `dev` script):

```bash
bun dev
```

**mprocs** (local convenience — create `development.mprocs.yaml` yourself):

```yaml
proc_list_title: Maple

procs:
    web:
        shell: bun dev:app
        cwd: apps/web
    api:
        shell: bun dev:app
        cwd: apps/api
    ingest:
        shell: bun dev:app
        cwd: apps/ingest
    scraper:
        shell: bun dev
        cwd: apps/scraper
```

Run with `mprocs development.mprocs.yaml`.

## Verify the stack

1. Open `http://localhost:3471` (or `https://web.localhost` with portless).
2. Sign in (self-hosted root password or Clerk test user).
3. Send test OTLP to `http://localhost:3474/v1/traces` (or your ingest port) with a
   well-formed ingest key, or rely on static-key mode (any `maple_pk_*` key resolves to
   `MAPLE_ORG_ID_OVERRIDE`).
4. Confirm data in the traces/logs UI after the collector batch flushes (~seconds).

Health checks:

- OTel collector: `http://localhost:13133`
- Scraper: `http://localhost:3475/health`
- API: `http://localhost:3472/health`

## Tests and quality

```bash
bun test
bun typecheck
bun run format   # oxfmt + oxlint --fix
```

Vitest uses embedded PGlite — no Docker Postgres required for unit tests.

## Troubleshooting

| Symptom                  | Check                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| API fails on startup     | Missing `MAPLE_INGEST_KEY_*`, `MAPLE_ROOT_PASSWORD`, or `TINYBIRD_*`                       |
| Ingest 401 on OTLP       | Static key store: use `maple_pk_…` prefix; postgres store: seed keys via API               |
| Empty traces UI          | ClickHouse schema applied? Collector running? `INGEST_WRITE_MODE=forward`?                 |
| API DB errors            | `docker compose … up -d postgres` + `bun run db:migrate:local`                             |
| Ingest/API HMAC mismatch | `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` must be identical; compare startup fingerprints in logs |
| Chat MCP tools fail      | `INTERNAL_SERVICE_TOKEN` mismatch or API not running                                       |

## Further reading

- [docs/persistence.md](docs/persistence.md) — Postgres migrations
- [docs/self-hosted-clickhouse.md](docs/self-hosted-clickhouse.md) — ClickHouse BYO + schema
- [docs/local-mode.md](docs/local-mode.md) — single-binary local mode
- [.env.example](.env.example) — full env reference with optional integrations (GitHub App, Hazel, Autumn, email)
