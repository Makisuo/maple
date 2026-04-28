# Persistence Operations

Maple stores dashboard persistence data in SQLite/libSQL and uses Drizzle migrations.

## Modes

- Local default: `MAPLE_DB_URL` unset, DB file at `apps/api/.data/maple.db`
- Turso/libSQL remote: set `MAPLE_DB_URL` and `MAPLE_DB_AUTH_TOKEN`

## Migration Commands

Run from repo root:

```bash
bun run db:migrate
```

Generate new migration from schema changes:

```bash
bun run db:generate
```

Apply schema directly without migration files (development utility):

```bash
bun run db:push
```

Open Drizzle Studio:

```bash
bun run db:studio
```

## API Runtime Behavior

`@maple/api` runs `db:migrate` automatically before `dev` and `start` so pending migrations are applied at startup.

## Self-Host Note

For file-based mode, mount/persist `apps/api/.data` in your runtime environment.

## Tinybird Materialized Views and TTL Coupling

Materialized view TTLs in `packages/domain/src/tinybird/materializations.ts` and their target datasources in `packages/domain/src/tinybird/datasources.ts` must match the source table TTL. Today all sources (`traces`, `logs`) and their MV targets are 90 days.

Two operational consequences:

1. **Backfill ceiling.** When deploying a new MV with `POPULATE`, you can only backfill data the source table still has — anything aged past the source TTL is lost. Plan deploys before any TTL reduction.

2. **TTL changes ship in lockstep.** If raw-table TTL changes (e.g., dropping `traces` to 30 days for cost), every MV target reading from it needs the same change in the same Tinybird deploy. A mismatched TTL leaves orphaned aggregate rows that never roll off.

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
