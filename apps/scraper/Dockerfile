# Build context: repo root (workspace deps @maple/domain + @maple-dev/effect-sdk).
# Railway: set the service's config file path to apps/scraper/railway.json and
# keep the root directory at the repo root.
FROM oven/bun:1.4.0 AS runner
WORKDIR /app

COPY . .
# @maple-dev/clickhouse-builder resolves through its dist/ exports, and
# @maple/domain imports its ./sql subpath — build it or the container
# crashloops at startup on a clean checkout.
RUN bun install --frozen-lockfile \
	&& bun run --cwd lib/clickhouse-builder build \
	&& bun run --cwd packages/effect-sdk build

EXPOSE 3475

CMD ["bun", "run", "apps/scraper/src/main.ts"]
