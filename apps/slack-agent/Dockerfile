# Node runtime + bun for dependency management.
#
# eve runs on Node, not bun: its dev server uses crossws' Node adapter, which
# refuses non-Node runtimes ("Using Node.js adapter in an incompatible
# environment"), and eve hard-requires Node >=24. Bun is used only as the
# package manager (fast installs + bun.lock), matching the rest of the repo.
# Keeping Node here means local and container run the same runtime.
#
# The Railway service's root directory is apps/slack-agent, so the build
# context is this folder (no monorepo involvement).
FROM node:24-slim

# Bun, for `bun install` only.
COPY --from=oven/bun:1.3-slim /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Fonts for chart rendering: agent/tools/render_chart.ts rasterizes SVG text
# via @resvg/resvg-js with loadSystemFonts — node:24-slim ships no fonts, so
# titles/labels would silently render blank without this.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching, from the committed bun.lock.
# patches/ must be present before install: package.json's patchedDependencies
# applies patches/eve@*.patch (multi-workspace botToken context, vercel/eve#222).
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY agent ./agent

# IMPORTANT: eve resolves `experimental.workflow.world` at BUILD time (agent.ts is
# compiled into eve's manifest), not at runtime. This must be set before the build
# or the image silently falls back to the ephemeral on-disk local world.
ENV EVE_WORKFLOW_WORLD=@workflow/world-postgres

# IMPORTANT: the Maple MCP connection URL is built from MAPLE_API_BASE_URL and is
# also baked into eve's manifest at BUILD time. Railway exposes service variables
# as Docker build args when they are declared with ARG, so set MAPLE_API_BASE_URL
# as a service variable and it becomes available here. If unset at build, the URL
# silently bakes to the local-dev default (https://api.localhost).
ARG MAPLE_API_BASE_URL
ENV MAPLE_API_BASE_URL=${MAPLE_API_BASE_URL}

RUN npm run build

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
# 8080 everywhere: matches the PORT Railway injects at runtime (which would otherwise
# silently override a different value here), and keeps local `docker run` identical to prod.
# If you change this, change it in all four places: here, EXPOSE, docker-entrypoint.sh's
# fallback, and WORKFLOW_LOCAL_BASE_URL / the generated domain's port in README step 2.
ENV PORT=8080
EXPOSE 8080

CMD ["./docker-entrypoint.sh"]
