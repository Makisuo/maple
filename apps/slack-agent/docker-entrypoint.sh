#!/usr/bin/env sh
set -e

: "${PORT:=8080}"
export PORT

# When the durable Postgres world is compiled in (see Dockerfile), apply its
# schema before starting. The migration is idempotent (drizzle tracks applied
# migrations), so running it on every boot is safe. Requires WORKFLOW_POSTGRES_URL
# or DATABASE_URL to be set.
case "${EVE_WORKFLOW_WORLD:-}" in
  *world-postgres*)
    echo "[entrypoint] Applying @workflow/world-postgres schema..."
    node ./node_modules/@workflow/world-postgres/bin/setup.js
    ;;
esac

echo "[entrypoint] Starting eve on port ${PORT}..."
# Go through `eve start` (NOT `node .output/server/index.mjs` directly): it
# runs prewarmBuiltAppSandboxes() before serving, which provisions the
# just-bash sandbox template under .eve/sandbox-cache/. Skills
# (agent/skills/) are served from that sandbox — without the prewarm every
# turn dies with SandboxTemplateNotProvisionedError. `eve start` handles
# SIGTERM/SIGINT and terminates the server child gracefully, so it is safe
# as PID 1.
exec node node_modules/eve/bin/eve.js start
