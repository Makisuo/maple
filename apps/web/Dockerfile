# Build context: monorepo root (.)
FROM oven/bun:1.3.11 AS base
WORKDIR /app

FROM base AS pruner
COPY . .
RUN bunx turbo prune @maple/web --docker --out-dir /app/out

FROM base AS build
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  rm -rf /var/lib/apt/lists/*
RUN bun install
COPY --from=pruner /app/out/full/ ./

# Build workspace dependencies that publish from dist/
RUN bun run --cwd lib/clickhouse-builder build && \
    bun run --cwd packages/browser build && \
    bun run --cwd packages/effect-sdk build

# Build-time env vars (baked into the SPA bundle)
ARG VITE_API_BASE_URL
ARG VITE_MAPLE_AUTH_MODE=self_hosted
ARG VITE_ELECTRIC_SYNC_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_MAPLE_AUTH_MODE=$VITE_MAPLE_AUTH_MODE
ENV VITE_ELECTRIC_SYNC_URL=$VITE_ELECTRIC_SYNC_URL

RUN bun run --cwd apps/web build

FROM nginx:1.27-alpine AS serve
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
