# ElectricSQL sync (TanStack DB)

Maple syncs a small set of **relational control-plane tables** to the web app in
real time using [ElectricSQL](https://electric.ax) shapes fronted by
[TanStack DB](https://tanstack.com/db) collections. Warehouse/analytics data
(traces, logs, metrics via `@maple/query-engine`) is **not** synced — it stays on
the effect-atom + `WarehouseQueryService` path.

Electric sync is the **only read path** for the dashboards, alerts, and
error-issue verticals — there is no fetch fallback, so the web app needs the
sync worker (and its upstream Electric) reachable for those lists to load.

The reusable machinery lives in the **`@maple/effect-db`** workspace package
(source-only, consumed by `apps/web`'s Vite and, later, the mobile app):

- `@maple/effect-db/electric` — `createEffectCollection` (an Effect-native wrapper
  over `@tanstack/electric-db-collection`: Effect Schema rows + `Effect` write
  handlers run on a `ManagedRuntime` + exponential backoff + typed `awaitTxIdEffect`),
  and `optimisticAction` (declare collections → optimistic apply → `Effect` server
  call returning a txid → automatic `awaitTxId` across all declared collections →
  typed errors). The backoff `onError` also dispatches the `auth:session-expired`
  (401) and `collection:schema-error` (post-deploy schema drift) window events.
- `@maple/effect-db/atom` — `makeQuery`/`makeQueryUnsafe`/`makeCollectionAtom`,
  bridging a TanStack DB live query to an effect-atom `Atom<AsyncResult<…>>`.

Ported and adapted from the hazel repo's two libraries to effect `4.0.0-beta.93`
(`Effect.catch` → `Effect.catchEager`; the electric collection utils slimmed to
`{ awaitTxId, awaitMatch }`).

## How it fits together

```
Browser (apps/web)
  TanStack DB collections, one set per active org
    read:  ShapeStream → GET {VITE_ELECTRIC_SYNC_URL}/api/sync/shape?shape=<name>&offset=…&handle=…
           (mapleShapeFetch injects the Clerk / self-hosted bearer)
    write: typed HTTP endpoints on apps/api (dashboards use public `/v2`; Electric is read-path only)

apps/electric-sync Worker — /api/sync/shape  (src/routes/shape.http.ts, a raw HttpRouter)
  a standalone, DB-free worker (deploys independently of apps/api)
  auth: Clerk/self-hosted tenant resolution ONLY (makeResolveTenant, shared from
        @maple/api/electric-sync) — no API-key path, since it has no database
  pins: table + `"org_id" = $1` (+ per-shape extra WHERE), params[1]=orgId, source_id/secret
  forwards ONLY offset/handle/live/cursor from the client
  streams Electric's response back (buffers the long-poll body)

Electric (Electric Cloud in prod / docker `electric` locally)
  ← logical replication ← PlanetScale Postgres (direct 5432, publication electric_publication_default)

writes: endpoint captures the Postgres txid on the mutating statement
  (`pg_current_xact_id()::xid::text`, apps/api/src/lib/electric-txid.ts) and returns it;
  the collection's write handler passes it to awaitTxId, which drops optimistic
  state once that transaction arrives on the shape stream.
```

### Shapes (server-pinned whitelist, `apps/electric-sync/src/routes/shape.http.ts`)

| shape                | table              | pinned columns / extra WHERE (besides org scope) |
| -------------------- | ------------------ | ------------------------------------------------ |
| `dashboards`         | dashboards         | —                                                |
| `alert_rules`        | alert_rules        | —                                                |
| `alert_rule_states`  | alert_rule_states  | —                                                |
| `alert_incidents`    | alert_incidents    | —                                                |
| `alert_destinations` | alert_destinations | columns: drops the encrypted `secret_*`          |
| `api_keys`           | api_keys           | columns: drops `key_hash` / `metadata_json`      |

Shape `where`/columns are **immutable** — changing a pinned predicate forces a
full re-sync for every client. If you must change one, version the shape name
(e.g. `dashboards.v2`) so old clients keep working during a deploy overlap.

The whitelist and `electric_publication_default` must stay in step **both ways**:
a shape over an unpublished table never receives changes (Electric runs with
`ELECTRIC_MANUAL_TABLE_PUBLISHING=true` and will not publish one itself), and a
published table with no shape is pure replication cost. `error_issues`, `actors`,
`error_incidents` and `scrape_target_checks` were published for verticals that
have since moved back to the typed `/v2` endpoints, and were pruned from both by
`0022_electric_publication_prune`.

## Local development

1. `bun db:up` starts the docker Postgres (now with `wal_level=logical`) and the
   `electric` service (port 3473) — see `docker-compose.development.yml`.
   If your Postgres volume predates the `wal_level` change, recreate it:
   `docker compose -f docker-compose.development.yml up -d --force-recreate postgres electric`.
2. `bun db:migrate:local` applies migrations, including `0009_electric_publication`.
3. `.env.local`: `ELECTRIC_URL=http://localhost:3473` and
   `VITE_ELECTRIC_SYNC_URL=http://localhost:3476` (both already in `.env.example`).
   `ELECTRIC_URL` is now read by the `apps/electric-sync` worker (default port 3476);
   `VITE_ELECTRIC_SYNC_URL` points the web app's ShapeStreams at it.
4. Run the app (`bun dev`) — it starts the `electric-sync` worker alongside the
   others via portless. The dashboards/alerts/errors lists read exclusively from
   the sync path, so steps 1–3 are required for them to load.

Smoke-test the proxy directly (through the standalone worker; needs a bearer):
`curl -g 'http://localhost:3476/api/sync/shape?shape=dashboards&offset=-1' -H "authorization: Bearer <token>"`,
or hit Electric with no proxy: `curl -g 'http://localhost:3473/v1/shape?table=dashboards&offset=-1'`.

### Troubleshooting

**`Electric sync is not configured` (HTTP 503)** — the worker's 503 body when it has
no upstream `ELECTRIC_URL`. Two causes:

1. `ELECTRIC_URL` isn't set in `.env.local`. Set `ELECTRIC_URL=http://localhost:3473`,
   then **restart** the worker — `--env-file` is read once at wrangler startup, so a
   hot source reload won't pick it up (`bun dev`, or just the `electric-sync` task).
2. The docker `electric` service isn't running on `:3473`. `bun db:up` starts it now;
   confirm with `docker compose ps` (expect `maple-electric-1`).

**Shapes 404 / Electric can't find the publication** — the shape stream errors even
though the worker is configured. The `0009_electric_publication` migration wraps its
`CREATE PUBLICATION` in a `DO $$ … EXCEPTION WHEN OTHERS THEN RAISE NOTICE … END $$`
guard (so the PGlite test path doesn't abort on `CREATE PUBLICATION`, which PGlite
can't run). The downside: on real Postgres a genuine failure inside that block is
**silently swallowed** as a NOTICE and drizzle still records 0009 as applied — so
`bun db:migrate:local` will **not** re-run it. Verify and self-heal:

```bash
docker exec maple-postgres-1 psql -U maple -d maple -c "SELECT pubname FROM pg_publication;"
```

If `electric_publication_default` is absent, apply the publication + `REPLICA IDENTITY
FULL` directly (this is the body of `0009`; drizzle won't re-run it for you):

Note this is the **current** membership (0009 + 0011 + 0014 minus the tables 0022
pruned), not the literal body of `0009` — recreating it from 0009 alone would
re-publish the four dead tables.

```bash
docker exec -i maple-postgres-1 psql -U maple -d maple <<'SQL'
ALTER TABLE "dashboards"         REPLICA IDENTITY FULL;
ALTER TABLE "alert_rules"        REPLICA IDENTITY FULL;
ALTER TABLE "alert_rule_states"  REPLICA IDENTITY FULL;
ALTER TABLE "alert_incidents"    REPLICA IDENTITY FULL;
ALTER TABLE "alert_destinations" REPLICA IDENTITY FULL;
ALTER TABLE "api_keys"           REPLICA IDENTITY FULL;
CREATE PUBLICATION electric_publication_default FOR TABLE
  "dashboards","alert_rules","alert_rule_states","alert_incidents","alert_destinations","api_keys";
SQL
```

**Nothing syncs but no error** — check `VITE_ELECTRIC_SYNC_URL` points at the
running `electric-sync` worker and that the docker `electric` service is up. It's
a build-time constant, so a Vite restart is needed after changing it.

## Production runbook (PlanetScale + Electric Cloud)

1. **PlanetScale cluster params:** `wal_level=logical`, `max_replication_slots>=10`,
   `max_wal_senders>=10`, `max_slot_wal_keep_size>=4096`, `sync_replication_slots=on`,
   `hot_standby_feedback=on`.
2. **Dedicated role:** a Postgres role with `REPLICATION` + `SELECT` on the synced
   tables (avoid the ephemeral pscale migration roles).
3. **Migration:** `0009_electric_publication` ships via the normal CI
   `drizzle-kit migrate`. Because prod runs `ELECTRIC_MANUAL_TABLE_PUBLISHING=true`,
   Electric never needs to own the tables — the migration owns the publication,
   sidestepping PlanetScale's inability to reassign table ownership.
4. **Electric Cloud source:** point it at the **direct** connection string
   (port 5432 — not PSBouncer/6432, not Hyperdrive), `ELECTRIC_MANUAL_TABLE_PUBLISHING=true`.
   Record `source_id` / `secret`.
5. **Env:** set `ELECTRIC_URL`, `ELECTRIC_SOURCE_ID`, `ELECTRIC_SECRET` — now wired
   into the standalone sync worker (`apps/electric-sync/alchemy.run.ts` +
   `src/config.ts`), which also needs the auth env (`MAPLE_AUTH_MODE`,
   `MAPLE_ROOT_PASSWORD` or `CLERK_*`). The root `alchemy.run.ts` bakes the worker's
   public origin into the web build as `VITE_ELECTRIC_SYNC_URL`. Then `alchemy deploy`.
   With `ELECTRIC_URL` unset the proxy returns 503 and the synced lists fail to load.
6. Validate initial per-org snapshot sizes before deploying a new synced table.

## PR previews (per-PR Electric Cloud environment)

PR previews provision an ephemeral Electric Cloud **environment** `pr-<n>` + a
Postgres **source** per PR, mirroring the PlanetScale/Tinybird branch lifecycle.
`scripts/electric-pr-branch.ts` (`up`/`down <pr-number>`, driven from
`.github/workflows/deploy-pr-preview.yml`) uses `@electric-sql/cli`
(`ELECTRIC_API_TOKEN` auth) to, on open/synchronize: reuse (or create under
`ELECTRIC_PROJECT_ID`) the `pr-<n>` environment, reset its services, create a
fresh `postgres` source pointed at the PR branch's `MAPLE_PG_ELECTRIC_URL`
(direct 5432 through a dedicated `--with-replication` role — Electric requires
the REPLICATION role _attribute_, which is never inherited; the main CI role
stays non-replication because PlanetScale replication roles aren't grantable,
which would break the in-place reset's role assumption), polled until active,
and export
`ELECTRIC_URL`/`ELECTRIC_SOURCE_ID`/`ELECTRIC_SECRET` to `$GITHUB_ENV` (bound to
the electric-sync worker by alchemy). On close it deletes the environment
(cascades the source). Steps are gated on `ELECTRIC_API_TOKEN`, so previews stay
green (and the worker 503s) until the token lands in Infisical.

- The web build always reads through the sync path — provisioning the source is
  what makes it work in previews.
- **Publication:** the migrate step runs `0009` (creates
  `electric_publication_default`) before the source is created. The script passes
  `--manual-table-publishing` by default (prod parity; Electric reads that
  migration-owned publication — its default name — instead of owning the tables).
  Set `ELECTRIC_MANUAL_TABLE_PUBLISHING=false` to let Electric auto-manage
  publishing instead; `ELECTRIC_SERVICE_EXTRA_ARGS` remains the flag escape hatch.
  The script pins `@electric-sql/cli@0.0.10` (interface verified — `--json` is a
  global flag, `environments create` returns `environmentId`, the postgres service
  id is the shape-API `source_id`); re-verify before bumping the pin.
- **Caps:** each source counts against the Electric plan's max-databases limit and
  holds a PlanetScale replication slot; teardown on close is mandatory.

## Adding a synced table later

1. New Drizzle migration: `ALTER PUBLICATION electric_publication_default ADD TABLE "<t>";`
   plus `ALTER TABLE "<t>" REPLICA IDENTITY FULL;`. Prefer an explicit
   `pg_publication_tables` existence check for idempotency (as in `0022`) over
   `0009`'s `DO $$ … EXCEPTION WHEN OTHERS … END $$` guard — that guard swallows
   real failures while drizzle still records the migration as applied.
2. Add the shape to the whitelist in `apps/electric-sync/src/routes/shape.http.ts`.
3. Add a collection under `apps/web/src/lib/collections/` via
   `createEffectCollection` (model on `dashboards.ts` for a write vertical, or
   `alerts.ts` for a read-only one — an identity `Schema.Struct` row schema that
   mirrors the table columns, plus a `timestamptz` parser normalizing to ISO),
   register it in `org-collections.ts` (constructor + `cleanup()`), and point the
   consumer read at the collection.
4. Update `SYNCED_TABLES` in `packages/db/src/migrations.test.ts`.

### `REPLICA IDENTITY FULL` is not optional, and it is the main egress cost

Electric **refuses to serve a shape** over a table whose replica identity is not
`FULL`, answering every request for it with:

```
{"message":"Database table \"public.<t>\" does not have its replica identity set to FULL"}
```

This was checked empirically against `electricsql/electric:latest`, and it is
unconditional — it holds with and without a `where`, with and without a `columns`
projection, and with `(org_id, id)` present via `REPLICA IDENTITY USING INDEX`.

So `0009`'s stated rationale is wrong in its details (`DEFAULT` keys deletes on the
primary key perfectly well, composite or not) but binding in its conclusion. What has
*not* held up is its other claim — "these are low-write control-plane tables, so the
extra WAL volume is negligible." `FULL` writes the entire old row into the WAL on top
of the new one, and since Electric Cloud consumes the slot over a direct connection,
every one of those bytes is billed PlanetScale egress.

Because the per-write multiplier is not negotiable, **the only lever on a synced table
is its write rate.** Before adding a hot writer to one, gate it:

- the alerting scheduler's per-minute claim lock lives in the *unpublished*
  `alert_rule_claims` table (`0027`), not in `alert_rules`;
- `alert_rules.last_scheduled_at` is refreshed on a 5-minute heartbeat, SQL-gated so
  the off-beat ticks are zero-row updates that write no WAL tuple at all;
- `api_keys.last_used_at` is gated the same way in `ApiKeysService`, so an
  authenticated request no longer writes on the hot path;
- `alert_rule_states` has had `STATE_HEARTBEAT_MS` for the same reason.

Do not try to reclaim this by relaxing the replica identity — Electric will reject the
shape and the synced lists will fail to load outright, with no fetch fallback.

## Removing a synced table

Reverse order, and do all of it — a half-removal is what left four dead tables on
the slot. Drop the consumer + collection, drop the shape from the whitelist, then
a migration that drops the table from the publication **and** resets
`REPLICA IDENTITY DEFAULT` (FULL costs full-old-row WAL on every UPDATE/DELETE
whether or not the table is published). Move the table from `SYNCED_TABLES` to
`UNSYNCED_TABLES` in `migrations.test.ts`. See `0022_electric_publication_prune`.

## Status / remaining work

**Done and verified**

- Infra: docker `electric` + `wal_level=logical`; `0009_electric_publication`
  (applies via both `drizzle-kit migrate` and the PGlite test path — see
  `packages/db/src/migrations.test.ts`), with later publication migrations for
  wave-1 control-plane tables and `api_keys`.
- Shape proxy with org-scoping + client-param pinning, extracted into the
  standalone `apps/electric-sync` worker (`src/routes/shape.http.ts`; the
  security-critical pinning is unit-tested in `src/routes/shape.test.ts`).
- txid capture: dashboards (all writes), alert rules (create/update/delete), and
  error issues `heartbeat`/`assign`/`setSeverity`.
- **`@maple/effect-db`** package (typecheck-clean) + **dashboards** collection
  refactored onto `createEffectCollection` + the `useDashboardStore` collection
  path, with writes migrated to `/v2/dashboards` and reconciled by returned txid;
  proven against a live Electric 1.6.2 instance locally.
- **Alerts read consumers (Phase 6):** `collections/alerts.ts` (read-only
  collections; client-side live-query join `alert_rules ⟕ alert_rule_states`);
  `useAlertRulesList` / `useAlertIncidentsList` / `useAlertDestinationsList` hooks
  read from the collections (writes stay on the typed endpoints — the shape stream
  delivers results). The row→document mappers mirror the server's
  `rowToRuleDocument`/`rowToDestinationDocument` and are unit-tested
  (`collections/alerts.test.ts`). The parallel **errors** vertical
  (`collections/errors.ts`, `error_issues ⟕ actors ⟕ open_error_incidents`) was
  built and then reverted to the typed `/v2` reads; its tables were pruned from
  the publication by `0022`.
- **API keys:** `collections/api-keys.ts` behind a column-restricted shape.
- **Self-heal:** a `collection:schema-error` listener in `org-collections.ts`
  recreates the org's collections (generation bump) so a post-deploy shape-schema
  drift re-fetches instead of getting stuck.

**Remaining (follow-ups)**

- **Live smoke of alerts:** the mappers/joins/timestamps typecheck and unit-test
  green, but the end-to-end sync for this vertical still needs the docker-Electric
  smoke (verify each list streams in scoped to the org and updates live after a
  write) — same validation dashboards already passed.
- **Row-volume check** before enabling any further list sync: confirm the per-org
  row counts are bounded; if not, add an archival tick or keep terminal-state tabs
  on paged effect-atom reads.
- **`alert_rules` write churn:** the scheduler's claim-lock CAS writes
  `alert_rules.last_scheduled_at` every minute per enabled rule, churning that
  shape. The fix is write-side (move the claim lock off the synced table) — a
  column-subset shape is not the answer.
