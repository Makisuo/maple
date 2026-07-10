# Build context: repo root (workspace deps @maple/domain + @maple-dev/effect-sdk).
# Railway: set the service's config file path to apps/railway-connector/railway.json
# and keep the root directory at the repo root. Required env: MAPLE_API_URL,
# SD_INTERNAL_TOKEN, MAPLE_INGEST_URL (see src/Env.ts). Run exactly ONE replica —
# two would double-ingest every log line (no lease coordination in v1).
FROM oven/bun:1.2 AS runner
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile && bun run --cwd lib/effect-sdk build

EXPOSE 3476

CMD ["bun", "run", "apps/railway-connector/src/main.ts"]
