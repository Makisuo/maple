<p align="center">
  <img src=".github/assets/maple-hero.png" alt="Maple — open-source observability for traces, logs, and metrics, built on OpenTelemetry" width="100%" />
</p>

<p align="center">
  <strong>Open-source observability for traces, logs &amp; metrics — built on OpenTelemetry + ClickHouse.</strong>
</p>

# Maple Monorepo

Maple is now organized as a monorepo with a SPA frontend and an Effect-based backend API.

## Workspace Layout

- `apps/web`: TanStack Router SPA (Vite)
- `apps/api`: Effect HTTP API (Tinybird proxy + MCP server code)
- `apps/ingest`: OTLP ingest gateway (key auth + org enrichment + collector forwarding)
- `apps/landing`: Astro landing site
- `apps/alerting`: Alert evaluation worker
- `apps/chat-flue`: Flue + Workers AI chat backend (agent + triage workflow)
- `apps/cli`: CLI utilities
- `apps/mobile`: Expo mobile app
- `packages/domain`: Shared Effect HTTP contracts and domain types
- `packages/query-engine`: Shared query and observability logic
- `packages/ui`: Shared UI primitives and components

## Prerequisites

- Bun `>=1.3`

## Install

```bash
bun install
```

## Try Maple Locally

Run Maple as a single local binary with OTLP ingest, embedded ClickHouse, and
the dashboard:

```bash
brew install Makisuo/tap/maple
maple start
```

See [docs/local-mode.md](docs/local-mode.md) for Homebrew, manual installer,
update, and uninstall details.

## Develop

Run every available `dev` task in the monorepo:

```bash
bun run dev
```

Run individual apps from the repo root with workspace filters:

```bash
bun --filter=@maple/web dev
bun --filter=@maple/api dev
bun --filter=@maple/ingest dev
bun --filter=@maple/landing dev
```

There is also a dedicated root helper for alerting:

```bash
bun run dev:alerting
```

Turbo dev runs in TUI mode so interactive servers stay attached.

## Validate

```bash
bun run typecheck
bun run build
bun run test
```

## Docker (Local)

Run the local multi-service stack (API + web + ingest + otel collector):

```bash
docker compose -f docker-compose.yml up --build
```

Services:

- API: `http://localhost:3472`
- Web: `http://localhost:3471`
- Ingest: `http://localhost:3474`
- OTEL collector: `4317` (gRPC), `4318` (HTTP), `13133` (health/extensions)

## Cloudflare Deploy (Alchemy)

Deployments are per-app Alchemy runs pinned to Cloudflare Workers + D1:

- `apps/api/alchemy.run.ts` — D1 database `MAPLE_DB` + api Worker with all env bindings
- `apps/landing/alchemy.run.ts` — Astro build + Worker serving static assets
- `apps/web/alchemy.run.ts` — TanStack Start app via the `Vite()` resource

Stage grammar is `prd` / `stg` / `pr-<number>`, resolved via `@maple/infra/cloudflare` (`parseMapleStage`, `resolveMapleDomains`, `resolveWorkerName`, `resolveD1Name`).

Run locally:

```bash
bun run alchemy:deploy:prd
bun run alchemy:deploy:stg
PR_NUMBER=123 bun run alchemy:deploy:pr
```

Tear down:

```bash
bun run alchemy:destroy:prd
bun run alchemy:destroy:stg
PR_NUMBER=123 bun run alchemy:destroy:pr
```

CI workflows:

- STG (default on push to `main`): `.github/workflows/deploy-stg.yml`
- PRD (manual only via `workflow_dispatch`): `.github/workflows/deploy-prd.yml`
- PR preview lifecycle: `.github/workflows/deploy-pr-preview.yml` (`pull_request` opened/synchronize/reopened/closed)

Secrets source model (CI):

- Secrets are fetched from **Infisical** via `Infisical/secrets-action` using OIDC
  (credential-less — GitHub's OIDC token authenticates a machine identity, no long-lived
  token stored). CI needs:
    - GitHub repo **variable** `INFISICAL_PROJECT_SLUG` (the project slug — a
      **variable**, not a secret: GitHub masks secret values everywhere, and a
      slug like `maple` would then blank out the PR-preview deployment URL
      `app-pr-<n>.maple.dev`)
    - GitHub repo **secret** `INFISICAL_MACHINE_IDENTITY_ID` (the machine identity ID)
- Infisical environments (`prod`, `staging`, `dev` — mapped from the old Doppler
  `prd`/`stg`/`pr` configs) must define:
    - `ALCHEMY_PASSWORD`
    - `ALCHEMY_STATE_TOKEN`
    - `CLOUDFLARE_API_TOKEN`
    - `CLOUDFLARE_DEFAULT_ACCOUNT_ID`
    - `TINYBIRD_HOST`
    - `TINYBIRD_TOKEN`
    - `EMAIL_FROM` (sender address on an onboarded Cloudflare Email Service domain; delivery uses the `EMAIL` worker binding, no API key)
    - `MAPLE_INGEST_KEY_ENCRYPTION_KEY`
    - `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`
    - `MAPLE_AUTH_MODE`
    - `MAPLE_ROOT_PASSWORD` (required in `self_hosted` mode)
    - `CLERK_SECRET_KEY`
    - `CLERK_PUBLISHABLE_KEY`
    - `CLERK_JWT_KEY`

Setup note: the machine identity must have a **GitHub OIDC** auth method configured in Infisical (scoped to this repo, ideally to the `production`/`staging`/`pr-preview` GitHub environments) and read access to the project. The workflows select secrets via `project-slug` (`INFISICAL_PROJECT_SLUG`) and per-stage `env-slug` (`prod`/`staging`/`dev`).

Runtime API URL behavior:

- Deploy-time web builds resolve `VITE_API_BASE_URL` from the Cloudflare api worker domain (`api.maple.dev` in `prd`, `api-staging.maple.dev` in `stg`, worker.dev URL for `pr-*`).
- Local `bun --filter=@maple/web dev` can still use root `.env` `VITE_API_BASE_URL` for local API routing.

## Environment

- Canonical env example: `.env.example`
- API-only env example: `apps/api/.env.example`
- Real `.env` values are local-only and should stay untracked.

The web app expects `VITE_API_BASE_URL` to point to the API (defaults to `http://localhost:3472`).

For ingest + key auth, set these at minimum in your root `.env` when running the ingest gateway:

- `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`
- `MAPLE_INGEST_KEY_ENCRYPTION_KEY` (required for D1-backed ingest deployments)
- `INGEST_PORT`
- `INGEST_FORWARD_OTLP_ENDPOINT`
- `INGEST_FORWARD_TIMEOUT_MS`
- `INGEST_MAX_REQUEST_BODY_BYTES`
- `INGEST_REQUIRE_TLS`

## Persistence (SQLite / Turso)

Maple now persists dashboards in SQLite via libSQL:

- Default local mode: no Turso CLI needed. If `MAPLE_DB_URL` is unset, Maple uses `apps/api/.data/maple.db`.
- Turso cloud mode: set `MAPLE_DB_URL` to your Turso/libSQL URL and `MAPLE_DB_AUTH_TOKEN` to your token.
- Self-hosting: persist the `apps/api/.data` directory as a volume so dashboard state survives container/restart cycles.

Migration commands:

```bash
bun --filter=@maple/api db:migrate
bun --filter=@maple/db db:generate
bun --filter=@maple/db db:push
bun --filter=@maple/db db:studio
```

When running the API (`bun --filter=@maple/api dev` or `bun --filter=@maple/api start`), migrations are applied automatically before boot.

## Ingest Keys

- Maple now manages per-org ingest keys in the database (`public` + `private`).
- Keys are available in Settings and can be rerolled independently.
- Reroll revokes the previous key immediately.
- Private ingest keys are encrypted at rest with `MAPLE_INGEST_KEY_ENCRYPTION_KEY` (base64-encoded 32-byte key).
- Ingest key lookup/auth uses non-reversible HMAC hashes via `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`.

## Auth Modes

Maple supports exactly two auth modes via `MAPLE_AUTH_MODE`:

1. `clerk`
    - Create a Clerk application with Organizations enabled.
    - Set `MAPLE_AUTH_MODE=clerk`
    - Set `CLERK_SECRET_KEY`
    - Optionally set `CLERK_JWT_KEY` for networkless verification
    - Set `CLERK_PUBLISHABLE_KEY` for the web app
    - Optionally override `VITE_CLERK_SIGN_IN_URL` and `VITE_CLERK_SIGN_UP_URL`
2. `self_hosted`
    - Set `MAPLE_AUTH_MODE=self_hosted`
    - Set `MAPLE_ROOT_PASSWORD` (required)
    - Set `MAPLE_DEFAULT_ORG_ID` (defaults to `default`)
    - Users must sign in at `/sign-in` with the root password before accessing the dashboard/API.

Start apps:

```bash
bun --filter=@maple/api dev
bun --filter=@maple/web dev
```

Validate behavior:

- Clerk mode:
    - Signed-out users are redirected to `/sign-in`
    - Signed-in users without an active org are redirected to `/org-required`
    - Signed-in users with an active org can query the API with bearer auth
- Self-hosted mode:
    - Signed-out users are redirected to `/sign-in`
    - `MAPLE_ROOT_PASSWORD` login issues a bearer session token
    - Protected API routes reject requests without a valid bearer session token

Breaking change:

- Self-hosted multi-tenant JWT/API-key auth paths were removed.
- `MAPLE_ROOT_PASSWORD` is now required when `MAPLE_AUTH_MODE=self_hosted`.
