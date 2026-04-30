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

Two ways to apply the schema. Both run the **same migrations** from `@maple/domain/clickhouse` and use the **same** [`qualifyStatementForDatabase`](../packages/domain/src/clickhouse/qualify.ts) helper, so they're interchangeable.

### Via the Maple UI (default)

`Settings → BYO Backend → ClickHouse`. On save, the API connects to the supplied URL with the supplied credentials and:

1. Creates `_maple_schema_migrations` (the bookkeeping table) if missing.
2. Applies any unapplied migrations in version order.
3. Records each applied migration's `(version, applied_at, description)`.

If the connection fails or the user lacks DDL privileges, the save returns an error and the row is **not** persisted — so an unconfigured org never gets stuck pointed at a half-migrated CH instance.

Re-saving is safe. Already-applied migrations are skipped, and every statement uses `IF NOT EXISTS` as a second line of defense. Future schema upgrades land the same way: pull a new Maple API release, then have the org re-save (or any other write to the BYO row) to pick up new migrations.

### Via the standalone CLI

For airgapped clusters, CI checks, or when your CH credentials shouldn't pass through Maple's API:

```bash
bunx @maple/clickhouse-cli@latest apply \
  --url=https://your-ch.example.com \
  --user=maple --password=$CH_PASSWORD \
  --database=default

# What's applied + what's pending
bunx @maple/clickhouse-cli@latest status

# Print DDL that would run, no execution
bunx @maple/clickhouse-cli@latest dry-run
```

Connection flags fall back to `MAPLE_CH_URL`, `MAPLE_CH_USER`, `MAPLE_CH_PASSWORD`, `MAPLE_CH_DATABASE` env vars — handy in CI. See [`packages/clickhouse-cli/README.md`](../packages/clickhouse-cli/README.md).

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

The maintained path is **Option A: Maple's prebuilt OTel Collector image** (`mapleexporter` baked in). Three escape hatches stay supported for advanced setups.

### Option A — Maple OTel Collector (recommended)

A custom build of `otelcol-contrib` with the `mapleexporter` baked in. The exporter writes JSON-each-row directly into Maple's `traces` / `logs` / `metrics_*` tables, no shim required.

- **Image:** `ghcr.io/makisuo/maple/otel-collector-maple` (multi-arch — amd64 + arm64). Pin a tag (e.g. `0.1.5`); see [the package page](https://github.com/users/makisuo/packages/container/package/maple%2Fotel-collector-maple) for available versions.
- **Source:** [`packages/otel-collector-maple-exporter/`](../packages/otel-collector-maple-exporter/) — builder config in [`deploy/k8s-infra/builder-config.yaml`](../deploy/k8s-infra/builder-config.yaml), Dockerfile in [`deploy/k8s-infra/Dockerfile.otel-collector-maple`](../deploy/k8s-infra/Dockerfile.otel-collector-maple).

#### Step 1: apply the schema

Use the standalone CLI — no Maple API required, and your CH credentials never leave the machine running it:

```bash
bunx @maple/clickhouse-cli@latest apply \
  --url=https://your-ch.example.com \
  --user=maple --password=$CH_PASSWORD \
  --database=default
```

Or save credentials in the Maple UI under `Settings → BYO Backend → ClickHouse` and the API will run the same migrations on your behalf.

#### Step 2: deploy the collector

**Kubernetes** — install the [`maple-otel`](../deploy/maple-otel/) Helm chart:

```bash
helm install maple-otel oci://ghcr.io/makisuo/charts/maple-otel \
  --namespace maple --create-namespace \
  --set maple.orgId=org_xxx \
  --set maple.clickhouse.endpoint=https://your-ch.example.com \
  --set maple.clickhouse.password.value=$CH_PASSWORD
```

Apps then point `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://maple-otel.maple.svc.cluster.local:4318`.

**Anywhere else (Docker / VM / ECS / Nomad / …)** — download a pre-rendered config from Maple:

1. `Settings → BYO Backend → ClickHouse → Download collector config` (or `GET /api/org-clickhouse-settings/collector-config`).
2. Drop the YAML next to a copy of the image and run:

   ```bash
   docker run \
     -e MAPLE_CLICKHOUSE_PASSWORD=$CH_PASSWORD \
     -v ./collector.yaml:/etc/otel/config.yaml \
     -p 4317:4317 -p 4318:4318 \
     ghcr.io/makisuo/maple/otel-collector-maple:0.1.5
   ```

The rendered YAML carries your `org_id`, ClickHouse URL/user/database, and the standard memory_limiter → k8sattributes → batch → maple pipeline. The password is referenced via `${env:MAPLE_CLICKHOUSE_PASSWORD}` so the file is safe to share.

#### Org id resolution

The `mapleexporter` stamps `OrgId` from its own `org_id` config on every record — no upstream `resource/maple_org` processor required for the typical single-tenant deploy. For multi-tenant fan-out (one collector serving several Maple orgs) set `org_id_from_resource_attribute: maple_org_id` on the exporter and stamp the right id per-record upstream; see [`packages/otel-collector-maple-exporter/README.md`](../packages/otel-collector-maple-exporter/README.md).

### Option B — Tinybird exporter + a shim service

The original "drop-in for Tinybird Cloud users" path. Run otelcol-contrib's `tinybird` exporter and point it at a small shim that:

- Accepts `POST /v0/events?name=<datasource>` with NDJSON bodies.
- Applies the JSONPath mappings from `packages/domain/src/tinybird/datasources.ts` to project each row into the right column shape.
- Issues `INSERT INTO <datasource> FORMAT JSONEachRow` against ClickHouse.

The shim is not in this repo — operators write or fork their own. The JSONPath spec required to drive it is exposed via `emitJsonPathSpec()` in `@maple/domain/clickhouse`.

### Option C — Tinybird-Local

If you're not allergic to running another container, [tinybird-local](https://github.com/tinybirdco/tinybird-local) is a single-binary Tinybird-API-compatible local server backed by ClickHouse. The Tinybird exporter works against it unchanged. Heavier than Option A but useful when you want Tinybird's UI side-by-side.

### Option D — Direct INSERTs from your application

If you have a small, well-defined ingest path (e.g. you control the SDK that emits to Maple), nothing stops you from `INSERT INTO traces FORMAT JSONEachRow` directly. The JSONPath spec defines what shape the rows should be in. Each row should look like the Tinybird exporter's output — see the `$.…` paths in `datasources.ts`.

### Comparing the options

| | Option A (Maple OTel Collector) | Option B (shim) | Option C (Tinybird-Local) | Option D (direct INSERTs) |
|---|---|---|---|---|
| Setup steps | 2 (schema + collector) | Many (write shim) | 2 | Application-specific |
| Pre-built image | ✅ | — | ✅ (Tinybird's) | — |
| Multi-tenant fan-out | ✅ via `org_id_from_resource_attribute` | manual | manual | application |
| k8s pod metadata enrichment | ✅ baked into the image | manual | manual | manual |
| Standard OTel collector pipeline shape | ✅ | partial | partial | n/a |

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
