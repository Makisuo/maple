# Build context: monorepo root (.)
FROM oven/bun:1.3.8 AS base
WORKDIR /app

FROM base AS pruner
COPY . .
RUN bunx turbo prune @maple/api --docker --out-dir /app/out

FROM base AS installer
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  rm -rf /var/lib/apt/lists/*
RUN bun install
COPY --from=pruner /app/out/full/ ./
RUN bunx turbo typecheck

FROM oven/bun:1.3.8-slim AS runner
WORKDIR /app

COPY --from=installer --chown=bun:bun /app /app
USER bun

ENV NODE_ENV=production
ENV PORT=3472
EXPOSE 3472

WORKDIR /app/apps/api
CMD ["bun", "run", "start"]
