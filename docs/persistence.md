# Persistence Operations

Maple stores relational application state in PostgreSQL with a schema defined by Drizzle in
`packages/db/src/schema/`.

## Runtime modes

- **Production and staging:** one PlanetScale Postgres branch per stage. Cloudflare Workers
  connect through the `MAPLE_DB` Hyperdrive binding; the application never opens the direct
  administrative connection.
- **Wrangler development:** Docker Postgres on port 5499 through Hyperdrive's
  `localConnectionString`.
- **Non-Worker local entrypoints and tests:** embedded PGlite. `MAPLE_DB_URL` is a PGlite data
  directory, or `memory://` for an ephemeral database. It is not a remote database URL.
- **PR previews:** no application database while preview deploys are disabled. Routes that
  need `Database` fail normally; DB-free routes such as health checks continue to work.

Application code keeps timestamps as epoch-millisecond numbers and converts at the Drizzle
boundary (`new Date(ms)` on write, `.getTime()` on read).

## Local development

Start and migrate the Docker Postgres used by Wrangler:

```bash
bun db:up
bun db:migrate:local
```

Persistent PGlite is created automatically for non-Worker local entrypoints under
`apps/api/.data/pglite`. Set `MAPLE_DB_URL=memory://` when persistence is not wanted.

## Authoring migrations

Change the Drizzle schema, then generate the SQL and metadata together:

```bash
bun run --cwd packages/db db:generate
```

Review the generated file in `packages/db/drizzle/` and its matching journal/snapshot changes.
Do not hand-create a migration without also updating `drizzle/meta/_journal.json`; both deployed
Postgres and PGlite use Drizzle's journal ordering.

Useful local commands:

```bash
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:push
bun run --cwd packages/db db:studio
```

`db:push` is a development utility only. Committed environments use migrations.

## Deployment and tests

CI runs `drizzle-kit migrate` against the stage's PlanetScale **direct** port 5432 before the
Alchemy deployment. Never run migrations through a pooler or Hyperdrive. The deployed Worker
does not migrate on boot.

PGlite applies the same bundled migrations while its layer is built. The test harness caches a
fresh migrated PGlite snapshot and restores it per test, so integration tests exercise the
PostgreSQL schema without a shared server.

## Tinybird Materialized Views and TTL Coupling

Raw `traces` and `logs` are retained for 30 days. Projection targets that preserve one row per
span or log use the same 30-day ceiling; aggregate targets intentionally retain rollups for 90 or
365 days. The TTL belongs to the target datasource in
`packages/domain/src/tinybird/datasources.ts`, not to the materialized-view definition.

Two operational consequences:

1. **Backfill ceiling.** When deploying a new MV with `POPULATE`, you can only backfill data the source table still has — anything aged past the source TTL is lost. Plan deploys before any TTL reduction.

2. **TTL changes require a target audit.** Keep row-level projections in lockstep with their raw
   source. Preserve the independently documented retention of hourly and error rollups unless the
   product retention policy changes too.

### Cardinality pre-flight for `traces_aggregates_hourly_mv`

Before deploying, confirm `SpanName` cardinality fits the MV sort key. Run against production:

```sql
SELECT
  OrgId,
  toStartOfHour(Timestamp) AS hour,
  uniq(SpanName) AS span_name_cardinality
FROM traces
WHERE Timestamp > now() - INTERVAL 7 DAY
GROUP BY OrgId, hour
ORDER BY span_name_cardinality DESC
LIMIT 50
```

Decision rule:

- p99 < 1K distinct → keep `SpanName` in MV dimensions (current setup)
- p99 1K–10K → keep but only route to MV when query has a `SpanName` filter
- p99 > 10K → drop `SpanName` from MV dimensions; group-by-span-name queries fall back to raw `traces`

High cardinality is usually a tenant emitting per-request data in span names (anti-pattern, but seen). Address at the source if found.
