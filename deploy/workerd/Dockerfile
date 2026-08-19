# Build context: monorepo root (.)
#
# Combined workerd container hosting the three Maple workers (api, alerting,
# electric-sync) in a single Miniflare process for self-hosted deploys outside
# Cloudflare. The control-plane database is external Postgres (MAPLE_PG_URL);
# KV / Durable Object / queue / workflow state persists to /data.

FROM oven/bun:1.3.11 AS base
WORKDIR /app

# ---- pruner: extract the relevant workspaces from the monorepo ----
FROM base AS pruner
COPY . .
RUN bunx turbo prune \
      @maple/api \
      @maple/alerting \
      @maple/electric-sync \
      @maple-dev/effect-sdk \
      @maple/clickhouse-cli \
      --docker --out-dir /app/out

# ---- builder: install + build SDK + bundle each worker ----
FROM base AS builder
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
RUN bun install
COPY --from=pruner /app/out/full/ ./

# These packages only expose pre-built `dist/` via their subpath exports —
# build them first so wrangler can resolve them during the worker bundle
# step (effect-sdk for the api entry, clickhouse-builder for the
# domain/query-engine imports).
RUN bunx turbo build --filter=@maple-dev/effect-sdk --filter=@maple-dev/clickhouse-builder

# Bundle each worker via wrangler dry-run. Each emits a self-contained
# module bundle at <outdir>/<entry>.js.
RUN cd apps/api && bunx wrangler deploy --dry-run --outdir=/build/api
RUN cd apps/alerting && bunx wrangler deploy --dry-run --outdir=/build/alerting
RUN cd apps/electric-sync && bunx wrangler deploy --dry-run --outdir=/build/electric-sync

# Bundle the ClickHouse schema CLI from this same source tree. Baking it in
# pins the CLI to whatever Maple commit our fork was synced to, so schema
# applied at boot stays in lockstep with what the API expects (no surprise
# `@latest` pulls at deploy time).
RUN bun build packages/clickhouse-cli/src/cli.ts \
      --target=bun \
      --outfile=/build/clickhouse-cli.js

# ---- runner: minimal image that runs the Miniflare orchestrator ----
FROM base AS runner
WORKDIR /app

# Worker bundles
COPY --from=builder /build/api/           /app/bundles/api/
COPY --from=builder /build/alerting/      /app/bundles/alerting/
COPY --from=builder /build/electric-sync/ /app/bundles/electric-sync/

# Each worker's wrangler.jsonc — runtime.ts derives its Miniflare bindings and
# cron schedules from these, so the runtime tracks upstream config with no
# manual mirroring.
COPY --from=builder /app/apps/api/wrangler.jsonc           /app/wrangler/api.jsonc
COPY --from=builder /app/apps/alerting/wrangler.jsonc      /app/wrangler/alerting.jsonc
COPY --from=builder /app/apps/electric-sync/wrangler.jsonc /app/wrangler/electric-sync.jsonc

# Drizzle migrations (Postgres) applied to MAPLE_PG_URL on boot — includes
# meta/_journal.json, which the drizzle migrator requires.
COPY --from=builder /app/packages/db/drizzle /app/migrations

# Baked ClickHouse schema CLI — invoked by the `maple-ch-migrate` init
# container (override the default CMD via docker-compose).
COPY --from=builder /build/clickhouse-cli.js /app/clickhouse-cli.js

# Runtime entry + its deps
COPY deploy/workerd/package.json deploy/workerd/bun.lock deploy/workerd/runtime.ts ./
RUN bun install --production --frozen-lockfile

ENV NODE_ENV=production
ENV MAPLE_DATA_DIR=/data
ENV API_PORT=3472
ENV ELECTRIC_SYNC_PORT=3476

EXPOSE 3472 3476

CMD ["bun", "runtime.ts"]
