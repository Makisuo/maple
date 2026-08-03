# Build context: repo root (workspace deps @maple/domain + @maple-dev/effect-sdk).
# Railway: set the service's config file path to apps/scraper/railway.json and
# keep the root directory at the repo root.
FROM oven/bun:1.3.11 AS runner
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile && bun run --cwd packages/effect-sdk build

EXPOSE 3475

CMD ["bun", "run", "apps/scraper/src/main.ts"]
