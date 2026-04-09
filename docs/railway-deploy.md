# Railway Deployment (Alchemy)

Maple deploys Railway and Cloudflare from one Alchemy entrypoint:

- Entrypoint: `apps/web/alchemy.run.ts`
- Shared Railway orchestration: `@maple/infra/railway` (`packages/infra/src/railway/index.ts`)
- Per-service Railway config:
  - `packages/infra/src/railway/services/api.ts`
  - `packages/infra/src/railway/services/ingest.ts`
  - `packages/infra/src/railway/services/otel-collector.ts`

## Stage Model

- Stage names are strict: `prd`, `stg`, `pr-<number>`
- Railway uses one project (`maple`) with many environments:
  - `prd` -> default production environment
  - `stg` -> Railway environment named `stg`
  - `pr-<number>` -> Railway environment named `pr-<number>`
- Service names are stage-scoped:
  - `prd`: `api`, `ingest`, `otel-collector`
  - `stg`: `api-stg`, `ingest-stg`, `otel-collector-stg`
  - `pr-<number>`: `api-pr-<number>`, `ingest-pr-<number>`, `otel-collector-pr-<number>`

## Domains

- Web domains:
  - `prd` -> `app.maple.dev`
  - `stg` -> `staging.maple.dev`
  - `pr-*` -> Cloudflare-generated preview URL
- Railway domains:
  - `prd` uses custom domains:
    - `api` -> `api.maple.dev`
    - `ingest` -> `ingest.maple.dev`
  - `stg` and `pr-*` use Railway-generated public domains for `api` and `ingest`
  - `otel-collector` remains private

## Required Secrets

CI uses Doppler runtime injection.

Set in GitHub Actions:

- `DOPPLER_TOKEN` (read-only service token)

Set in each Doppler config (`prd`, `stg`, `pr`):

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
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_KEY`

Do not keep these legacy vars in Doppler:

- `MAPLE_DEPLOY_WEB_ONLY`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_MAPLE_AUTH_MODE`

## Local Deploy Commands

Deploy:

```bash
bun run deploy:prd
bun run deploy:stg
PR_NUMBER=123 bun run deploy:pr
```

Deploy/destroy scripts are strict full-stack actions (Railway + Cloudflare) and require `RAILWAY_API_TOKEN`.

Destroy:

```bash
bun run destroy:prd
bun run destroy:stg
PR_NUMBER=123 bun run destroy:pr
```

## CI Workflows

- PRD: `.github/workflows/deploy-prd.yml`
  - Trigger: `push` on `main`, `workflow_dispatch`
  - Doppler config: `prd`
  - Action: `bun run deploy:prd`
- STG: `.github/workflows/deploy-stg.yml`
  - Trigger: `push` on `develop`, `workflow_dispatch`
  - Doppler config: `stg`
  - Action: `bun run deploy:stg`
- PR preview lifecycle: `.github/workflows/deploy-pr-preview.yml`
  - Trigger: `pull_request` `opened`, `synchronize`, `reopened`, `closed`
  - Doppler config: `pr`
  - Actions:
    - non-closed events: `bun run deploy:pr`
    - closed event: `bun run destroy:pr`

## Runtime Networking

- `ingest` forwards OTLP to `http://<otel-service>.railway.internal:4318` by default.
- `apps/web` deploys always derive `VITE_API_BASE_URL` from the Railway API domain provisioned in the same run.
