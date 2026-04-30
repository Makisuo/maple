# Self-hosted Maple on plain ClickHouse

Self-managed Maple can run on a vanilla ClickHouse instance — no Tinybird Cloud, no Tinybird-Local. The query engine (`@maple/query-engine`) emits standard ClickHouse SQL, and the schema is generated from the same TypeScript source the Tinybird path uses.

## Scope

This doc covers two pieces:

1. **Schema setup** — generating + applying the ClickHouse DDL on a vanilla server.
2. **Runtime configuration** — pointing the Maple API at ClickHouse instead of Tinybird.

Ingest is still bring-your-own — see [Ingest options](#ingest-options) below.

## Required ClickHouse version

Tested on ClickHouse 24.8+. Earlier versions may work but aren't validated.

## How runtime config works

Self-managed Maple is a **per-org BYO** feature. Each org configures their own backend in Settings → BYO; the credentials live in the `org_tinybird_settings` table (encrypted at rest with `MAPLE_INGEST_KEY_ENCRYPTION_KEY`). A `backend` column discriminates between the two flavors:

- `backend = "tinybird"` — the existing path. Maple deploys its Tinybird project into the org's workspace via the sync workflow; queries route to that workspace.
- `backend = "clickhouse"` — new. The org points Maple at a vanilla ClickHouse server they operate themselves. There is no sync workflow — schema lives in their CH instance and is applied via the CLI below.

The Maple deployment itself still uses the env-level `TINYBIRD_HOST` / `TINYBIRD_TOKEN` for any org without a BYO row. None of the env vars need to change for ClickHouse-BYO to work.

### Routing precedence

For any given query the API resolves the upstream in this order:

1. **Per-org BYO row** — if `org_tinybird_settings` has an active row for the requesting org, the row's `backend` discriminator picks Tinybird or ClickHouse, and the row's credentials drive the connection.
2. **Managed Tinybird** — fall back to `TINYBIRD_HOST` + `TINYBIRD_TOKEN`.

### Configuring ClickHouse-BYO via the UI

`Settings → BYO Backend → ClickHouse` exposes:

- **ClickHouse URL** — the HTTP interface (e.g. `https://your-clickhouse.example.com:8123`)
- **User** — defaults to `default`. Must have DDL privileges (CREATE TABLE / CREATE MATERIALIZED VIEW) so the API can install the schema on save.
- **Database** — defaults to `default`
- **Password** — optional; encrypted at rest. Leave blank to keep an existing password when re-saving.

On save, the API connects to the instance, creates the schema (or skips if it already exists) inside an idempotent migration loop, and only then persists the BYO row. There is no resync flow — schema lives in your CH instance and there's nothing to push back to it.

## Applying the schema

Schema is applied automatically when an org saves a ClickHouse-backed BYO row. There is no separate CLI to run — the API connects to the supplied URL with the supplied credentials and:

1. Creates `_maple_schema_migrations` (the bookkeeping table) if missing.
2. Applies any unapplied migrations in version order.
3. Records each applied migration's `(version, applied_at, description)`.

If the connection fails or the user lacks DDL privileges, the save returns an error and the row is **not** persisted — so an unconfigured org never gets stuck pointed at a half-migrated CH instance.

Re-saving is safe. Already-applied migrations are skipped, and every statement uses `IF NOT EXISTS` as a second line of defense. Future schema upgrades land the same way: pull a new Maple API release, then have the org re-save (or any other write to the BYO row) to pick up new migrations.

To inspect applied migrations directly on your CH server:

```sql
SELECT version, applied_at, description FROM _maple_schema_migrations ORDER BY version;
```

## What gets created

On a clean install, migration 0001 creates **20 tables** (datasources) and **22 materialized views**:

- **Direct-ingest tables**: `traces`, `logs`, `metrics_sum`, `metrics_gauge`, `metrics_histogram`, `metrics_exponential_histogram`, `alert_checks`
- **MV-populated tables**: `service_usage`, `service_map_spans`, `service_map_children`, `service_map_edges_hourly`, `service_overview_spans`, `error_spans`, `error_events`, `trace_list_mv`, `trace_detail_spans`, `attribute_keys_hourly`, `attribute_values_hourly`, `traces_aggregates_hourly`, `logs_aggregates_hourly`
- **Materialized views**: 22 MVs that fan out from the direct-ingest tables to populate the MV-populated tables

Every table is partitioned by date and carries a 90-day TTL (365 days on metrics) — adjust by writing a follow-up migration if your retention requirements differ.

## Ingest options

Maple's schema is what matters — the path data takes to get there is up to you. A few approaches:

### Option 1 — OTel Collector + Tinybird exporter pointed at a Tinybird-API-compatible shim

This is the "drop-in" path. Run the OTel Collector with the `tinybird` exporter (from `otelcol-contrib`) and point its `endpoint` at a small shim service that:

- Accepts `POST /v0/events?name=<datasource>` with NDJSON bodies
- Applies the JSONPath mappings from `packages/domain/src/tinybird/datasources.ts` to project each row into the right column shape
- Issues `INSERT INTO <datasource> FORMAT JSONEachRow` against ClickHouse

The shim is not in this repo — operators write or fork their own. The JSONPath spec required to drive it is exposed via `emitJsonPathSpec()` in `@maple/domain/clickhouse`.

### Option 2 — OTel Collector with the native `clickhouse` exporter

`otelcol-contrib` ships a built-in ClickHouse exporter. **Note:** it expects its own schema (`otel_traces`, `otel_logs`, etc.) which does **not** match Maple's schema. To use it, you'd either need to remap the exporter's table names + column overrides, or front it with an OTel `transform` processor that projects into Maple's column layout. Most operators will find the shim simpler.

### Option 3 — Tinybird-Local

If you're not allergic to running another container, [tinybird-local](https://github.com/tinybirdco/tinybird-local) is a single-binary Tinybird-API-compatible local server backed by ClickHouse. The Tinybird exporter works against it unchanged. This is the lowest-friction path during early self-hosted exploration.

### Option 4 — Direct INSERTs from your application

If you have a small, well-defined ingest path (e.g. you control the SDK that emits to Maple), nothing stops you from `INSERT INTO traces FORMAT JSONEachRow` directly. The JSONPath spec defines what shape the rows should be in. Each row should look like the Tinybird exporter's output — see the `$.…` paths in `datasources.ts`.

## Schema source of truth

Schema lives in `packages/domain/src/tinybird/datasources.ts` and `materializations.ts`. These TypeScript files are consumed by **two** emitters:

- The Tinybird manifest emitter (existing) — produces `.datasource` / `.pipe` files for Tinybird Cloud
- The ClickHouse DDL emitter (new) — produces `CREATE TABLE` / `CREATE MATERIALIZED VIEW` statements

To regenerate the ClickHouse schema after a TS change:

```bash
bun run clickhouse:schema
```

CI checks this stays in sync via `bun run clickhouse:schema:check`.

## Extending the schema

To add a new column, table, or materialized view:

1. Edit `packages/domain/src/tinybird/datasources.ts` or `materializations.ts`.
2. Run `bun run clickhouse:schema` to regenerate the snapshot.
3. Create a new file `packages/domain/src/clickhouse/migrations/0002_<descriptive_name>.ts`:

   ```typescript
   export const migration_0002_add_foo_column = {
     version: 2,
     description: "Add Foo column to traces",
     statements: [
       "ALTER TABLE traces ADD COLUMN IF NOT EXISTS Foo String DEFAULT ''",
       // For columns with non-trivial DEFAULT expressions that need backfilling:
       "ALTER TABLE traces MATERIALIZE COLUMN Foo",
     ],
   } as const
   ```

4. Append it to the `migrations` array in `packages/domain/src/clickhouse/migrations/index.ts`.

The next `clickhouse:schema:apply` will pick it up and run only the new migration.

### Replacing Tinybird's `forwardQuery`

A handful of datasources use Tinybird's `forwardQuery` block to backfill computed columns when the schema evolves (e.g. `traces.SampleRate`, `traces.IsEntryPoint`). For self-hosted ClickHouse, the equivalent pattern is paired statements:

```sql
ALTER TABLE traces ADD COLUMN IF NOT EXISTS NewCol Type DEFAULT <expr>;
ALTER TABLE traces MATERIALIZE COLUMN NewCol;
```

`MATERIALIZE COLUMN` runs as a background mutation and populates existing rows using the `DEFAULT` expression. For per-row, idempotent expressions (the only kind currently in use) this is functionally equivalent to Tinybird's `forwardQuery`.

## Migrating from Tinybird-Local

Clean break is recommended — Maple's data has a 90-day TTL by default, so most operators can:

1. Stop your ingest path.
2. Bring up the new vanilla-ClickHouse stack and apply the schema.
3. Resume ingest. Old data ages out within 90 days.

If you need historical data preserved, Tinybird-Local exposes its underlying ClickHouse on port 7181, so a one-shot `INSERT INTO new.<table> SELECT * FROM tinybird_local.<table>` over `remote()` is feasible. This isn't currently shipped as tooling.

## Troubleshooting

- **Save fails with "ClickHouse rejected credentials"**: the user/password combo doesn't authenticate. Maple maps CH 401/403 responses to this error.
- **Save fails with "ClickHouse rejected statement"**: the configured user authenticates but lacks DDL privileges, or a migration ran into a CH-version-specific syntax issue. Check `system.query_log` on your CH server for the failing statement.
- **Save fails with "Could not reach ClickHouse"**: the API can't make an HTTP request to the URL. Network/DNS/firewall — verify the API can reach the URL.
- **Migration appears to hang on `MATERIALIZE COLUMN`**: this is a background mutation. Watch `system.mutations` to see progress.
- **`schema:check` fails in CI but the diff looks empty**: someone changed `datasources.ts` without running `bun run clickhouse:schema`. Run it locally and commit the regenerated file.
