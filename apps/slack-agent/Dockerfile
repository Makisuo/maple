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

# Install deps first for layer caching, from the committed bun.lock.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY agent ./agent

# IMPORTANT: eve resolves `experimental.workflow.world` at BUILD time (agent.ts is
# compiled into eve's manifest), not at runtime. This must be set before the build
# or the image silently falls back to the ephemeral on-disk local world.
ENV EVE_WORKFLOW_WORLD=@workflow/world-postgres
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
