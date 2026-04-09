# Maple Monorepo

Maple is now organized as a monorepo with a SPA frontend and an Effect-based backend API.

## Workspace Layout

- `apps/web`: TanStack Router SPA (Vite)
- `apps/api`: Effect HTTP API (Tinybird proxy + MCP server code)
- `apps/ingest`: OTLP ingest gateway (key auth + org enrichment + collector forwarding)
- `apps/landing`: Astro landing site
- `packages/domain`: Shared Effect HTTP contracts and domain types
- `packages/api-client`: Typed client used by the web app

## Prerequisites

- Bun `>=1.3`

## Install

```bash
bun install
```

## Develop

Run all app services (API + web + ingest + landing):

```bash
bun run dev:all
```

`dev:all` uses Turbo `--continue=always`, so if one service fails to bind (for example, a port already in use), other services keep running.
Dev scripts run Turbo in TUI mode so interactive dev servers (like Vite) stay attached.
Use strict fail-fast mode when needed:

```bash
bun run dev:all:strict
```

Run every available `dev` task in the monorepo:

```bash
bun run dev
```

Run only web:

```bash
bun run dev:web
```

Run only API:

```bash
bun run dev:api
```

Run only ingest gateway:

```bash
bun run dev:ingest
```

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

## Railway + Cloudflare Deploy (Alchemy)

Deployments are orchestrated from one Alchemy run in `apps/web/alchemy.run.ts` with stage-driven targets:

- Provisions Railway project `maple`
- Uses Railway environments per stage: `prd`, `stg`, and `pr-<number>`
- Provisions stage-scoped services `api`, `ingest`, and `otel-collector`
- Configures service instance settings (`rootDirectory`, `dockerfilePath`, `watchPatterns`)
- Applies required Railway variables for API and ingest
- Uses production custom Railway domains (`api.maple.dev`, `ingest.maple.dev`) and Railway-generated domains in `stg` / `pr-*`
- Deploys `apps/web` to Cloudflare

Railway orchestration module: `@maple/infra/railway` (workspace package at `packages/infra`).

Run locally:

```bash
bun run deploy:prd
bun run deploy:stg
PR_NUMBER=123 bun run deploy:pr
```

All deploy scripts are full-stack only (Railway + Cloudflare). If `RAILWAY_API_TOKEN` is missing, deploy/destroy fails immediately.

Tear down:

```bash
bun run destroy:prd
bun run destroy:stg
PR_NUMBER=123 bun run destroy:pr
```

CI workflows:

- PRD: `.github/workflows/deploy-prd.yml` (`push` on `main` + `workflow_dispatch`)
- STG: `.github/workflows/deploy-stg.yml` (`push` on `develop` + `workflow_dispatch`)
- PR preview lifecycle: `.github/workflows/deploy-pr-preview.yml` (`pull_request` opened/synchronize/reopened/closed)

Secrets source model (CI):

- GitHub Secrets (only one): `DOPPLER_TOKEN`
- Doppler configs (`prd`, `stg`, `pr`) must define:
  - `ALCHEMY_PASSWORD`
  - `ALCHEMY_STATE_TOKEN`
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_EMAIL`
  - `RAILWAY_API_TOKEN`
  - `RAILWAY_WORKSPACE_ID`
  - `TINYBIRD_HOST`
  - `TINYBIRD_TOKEN`
  - `RESEND_API_KEY`
  - `RESEND_FROM_EMAIL`
  - `MAPLE_DB_URL`
  - `MAPLE_DB_AUTH_TOKEN`
  - `MAPLE_INGEST_KEY_ENCRYPTION_KEY`
  - `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`
  - `MAPLE_AUTH_MODE`
  - `MAPLE_ROOT_PASSWORD` (required in `self_hosted` mode)
  - `CLERK_SECRET_KEY`
  - `CLERK_PUBLISHABLE_KEY`
  - `CLERK_JWT_KEY`

Free/Starter note: when using a personal Doppler token, the workflow must also specify Doppler selectors (`doppler-project`, `doppler-config`). This repo uses `maple` with stage configs `prd`, `stg`, and `pr`.

Runtime API URL behavior:

- Deploy-time web builds always use the Railway API domain from the same Alchemy run (`api.maple.dev` in `prd`, Railway-generated in `stg` / `pr-*`).
- Local `bun run dev:web` can still use root `.env` `VITE_API_BASE_URL` for local API routing.

Legacy env cleanup (delete these from Doppler):

- `MAPLE_DEPLOY_WEB_ONLY`

## Environment

- Canonical env example (used by `bun run dev:all`): `.env.example`
- API-only env example: `apps/api/.env.example`
- Real `.env` values are local-only and should stay untracked.

The web app expects `VITE_API_BASE_URL` to point to the API (defaults to `http://localhost:3472`).

For ingest + key auth, set these at minimum in your root `.env` when using `bun run dev:all`:

- `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`
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
bun run db:migrate
bun run db:generate
bun run db:push
bun run db:studio
```

When running the API (`bun run dev:api` or `bun run --filter=@maple/api start`), migrations are applied automatically before boot.

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
bun run dev:api
bun run dev:web
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
