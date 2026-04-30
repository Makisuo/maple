# @maple/clickhouse-cli

Apply Maple's ClickHouse schema (or check what's pending) against a vanilla
ClickHouse server. Standalone — no Maple API required.

## Quick start

```bash
# Apply every unapplied migration
bunx @maple/clickhouse-cli@latest apply \
  --url=https://my-ch.example.com \
  --user=maple --password=$PASS \
  --database=default

# What's currently applied + what's pending
bunx @maple/clickhouse-cli@latest status

# Print the DDL that would run, no execution
bunx @maple/clickhouse-cli@latest dry-run | less
```

Connection flags can also come from env vars: `MAPLE_CH_URL`,
`MAPLE_CH_USER`, `MAPLE_CH_PASSWORD`, `MAPLE_CH_DATABASE` — handy in CI.

## What it does

On `apply`:

1. Connects + checks credentials (`SELECT version()`).
2. Creates `_maple_schema_migrations` if absent (the bookkeeping table).
3. For each migration not yet recorded, runs every `IF NOT EXISTS`
   statement in version order.
4. Records the migration in `_maple_schema_migrations`.

Re-runs are safe — already-applied migrations are skipped, and every
statement is idempotent.

The migrations themselves are bundled with the CLI (sourced from
`@maple/domain/clickhouse`'s `migrations` array — the same source the Maple
API uses). `version` prints the bundled count + Maple project revision so
you can confirm parity with a deployed Maple build.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success. |
| 1 | Unexpected error (network, parse, etc). |
| 2 | Bad usage / missing flags. |
| 3 | ClickHouse rejected (bad creds, bad DDL). |
| 4 | ClickHouse upstream error (5xx). |

## Permissions on the user

The user passed via `--user` needs DDL privileges (`CREATE TABLE`,
`CREATE MATERIALIZED VIEW`) AND read access to `system.tables` /
`system.columns` for status checks. After the schema is in place, the
collector / app user only needs `SELECT` + `INSERT` on the Maple tables.

## CI usage

```yaml
# .github/workflows/clickhouse-schema-drift.yml
- name: Check pending migrations
  run: |
    bunx @maple/clickhouse-cli@latest status \
      --url=${{ vars.MAPLE_CH_URL }} \
      --user=${{ vars.MAPLE_CH_USER }} \
      --password=${{ secrets.MAPLE_CH_PASSWORD }} \
      --database=${{ vars.MAPLE_CH_DATABASE }} \
      | tee status.txt
    grep -q "pending:\n  (none)" status.txt
```
