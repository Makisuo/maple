#!/usr/bin/env sh
set -e

: "${PORT:=3000}"
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
exec node .output/server/index.mjs
