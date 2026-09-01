# ElectricSQL sync (TanStack DB)

Maple syncs a small set of **relational control-plane tables** to the web app in
real time using [ElectricSQL](https://electric.ax) shapes fronted by
[TanStack DB](https://tanstack.com/db) collections. Warehouse/analytics data
(traces, logs, metrics via `@maple/query-engine`) is **not** synced — it stays on
the effect-atom + `WarehouseQueryService` path.

Electric sync is the primary read path for the dashboards and alerts verticals.
Only `/dashboards` has a fallback: it degrades to a plain-HTTP snapshot with
writes disabled (`SyncDegradedBanner`). The alerts lists have none — with the
sync worker or its upstream unreachable they show `SyncUnavailable` and a retry.
So an Electric outage is visible, and a deploy of the singleton service is a
short one.

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
  pins: table + `"org_id" = $1` (+ per-shape extra WHERE), params[1]=orgId, secret
  forwards ONLY offset/handle/live/cursor from the client
  streams Electric's response back (buffers the long-poll body)

Electric (apps/electric on ECS Fargate in prod / docker `electric` locally)
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
3. `.env.local`: `ELECTRIC_URL=http://localhost:3473` (already in `.env.example`), read by
   the `apps/electric-sync` worker. Under `bun dev` the web app finds that worker at
   `https://electric-sync.localhost` on its own; `VITE_ELECTRIC_SYNC_URL` only matters when
   running the web app on a raw port without the portless proxy.
4. Run the app (`bun dev`) — the `electric-sync` worker comes up in the `alchemy dev`
   stack with everything else (`bun dev api electric-sync web` for just the pieces that
   matter here). The dashboards/alerts/errors lists read exclusively from the sync path, so
   steps 1–3 are required for them to load.

Smoke-test the proxy directly (through the standalone worker; needs a bearer):
`curl -g 'https://electric-sync.localhost/api/sync/shape?shape=dashboards&offset=-1' -H "authorization: Bearer <token>"`,
or hit Electric with no proxy: `curl -g 'http://localhost:3473/v1/shape?table=dashboards&offset=-1'`.

### Troubleshooting

**`Electric sync is not configured` (HTTP 503)** — the worker's 503 body when it has
no upstream `ELECTRIC_URL`. Two causes:

1. `ELECTRIC_URL` isn't set in `.env.local`. Set `ELECTRIC_URL=http://localhost:3473`,
   then **restart** `bun dev` — `--env-file` is read once when `alchemy dev` starts, so
   a hot source reload won't pick it up.
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

## Production (PlanetScale + self-hosted Electric on ECS)

Electric Cloud is gone. `apps/electric` runs the upstream `electricsql/electric`
image on ECS Fargate at `electric.maple.dev` / `electric-staging.maple.dev`, with
its own cluster, ALB, security groups and certificate **inside the ingest fleet's
VPC**. The shared VPC is forced, not an economy: two `AWS.EC2.Network`s in one
alchemy stack fight over the internet gateway — under `--adopt` the second one's
create resolves to the first's IGW and tries to detach it, which AWS refuses on a
VPC whose tasks hold public IPs (`DependencyViolation: … has some mapped public
address(es)`). Both services want the same network anyway: public subnets, public
IPs, no NAT.
Nothing was migrated to get there: Postgres is the source of truth and Electric
is a cache over its logical replication stream.

**What guards it.** The service is public, because its only caller is a Worker at
the Cloudflare edge with no private route into a VPC. `ELECTRIC_SECRET` is the
control — Electric requires it on every shape request, and the sync worker
appends it as `?secret=` exactly as it did for Cloud's source secret. One secret,
both ends of the hop. The task security group additionally admits `ELECTRIC_PORT`
only from the ALB's group, so a task's public IP is not a way around TLS.

**It is a singleton.** Two Electrics cannot share a replication slot, so the
service runs `desiredCount: 1` with `minimumHealthyPercent: 0` — stop the old
task, then start the new one. Every deploy therefore has a ~60s window with no
sync: `/dashboards` degrades to its HTTP snapshot (`SyncDegradedBanner`), while
the alerts lists have no fallback and sit in their retry state. This is why the
image tag is pinned in `apps/electric/Dockerfile` rather than tracking `:latest`
like local docker does.

### Standing it up

1. **PlanetScale cluster params:** `wal_level=logical`, `max_replication_slots>=10`,
   `max_wal_senders>=10`, `max_slot_wal_keep_size>=4096`, `sync_replication_slots=on`,
   `hot_standby_feedback=on`. Already set for Cloud; unchanged.
2. **Dedicated role** with the `REPLICATION` _attribute_ — never inherited through
   role membership, and Electric's database validation rejects a role without it
   with a message that does not say so — plus `SELECT` on the synced tables.
   Avoid the ephemeral pscale migration roles.
3. **Env:** `MAPLE_PG_ELECTRIC_URL` (that role, DIRECT port 5432 — logical
   replication cannot run through PSBouncer or Hyperdrive) and `ELECTRIC_SECRET`.
   Both reach the task through Secrets Manager, never the task definition's
   plaintext `env`.
4. **Migrate,** then `alchemy deploy`. No new migration is needed — the service
   reads the publication `0009`/`0011`/`0014`/`0037` already maintain.
5. **DNS.** The certificate lands `PENDING_VALIDATION` on the first deploy and the
   443 listener fails; the deploy workflows recover on their own by creating the
   validation CNAME and redeploying (`scripts/acm-cert-validate.sh`, which now
   names the electric domains alongside ingest). The one manual record is a
   **proxied CNAME for `electric.maple.dev` at the ALB** — the deploy output
   carries the hostname.
6. **Verify** before pointing anything at it:
   `curl https://electric.maple.dev/v1/health`, then a shape through the proxy —
   `curl -g 'https://sync.maple.dev/api/sync/shape?shape=dashboards&offset=-1' -H "authorization: Bearer <token>"`.
7. **Cut over:** set `ELECTRIC_URL=https://electric.maple.dev` and clear
   `ELECTRIC_SOURCE_ID`, then redeploy the sync worker. Reverting is the same env
   change backwards, which is the entire point of running the two side by side.

### The publication

`ELECTRIC_MANUAL_TABLE_PUBLISHING=true`, and `ELECTRIC_REPLICATION_STREAM_ID` is
left at Electric's `default` — so it reads `electric_publication_default`, the
migration-owned publication, and opens `electric_slot_default` for itself.

Electric Cloud never used that pair: it created its own generated
`cloud_electric_pub_*` / `cloud_electric_slot_*`. That is why the self-hosted
service can run beside it on the same database with no collision, and why
flipping `ELECTRIC_URL` between them is a reversible env change rather than a
leap.

## PR previews (no Electric source — dormant since 2026-08, now also Cloud-less)

**PR previews no longer have an Electric source.** They stopped provisioning a
PlanetScale branch (see `resolveDatabaseMode` in
`packages/infra/src/cloudflare/stage.ts`), and with no Postgres to replicate from
there is nothing for Electric to point at. `apps/electric-sync/alchemy.run.ts`
therefore withholds `ELECTRIC_URL`/`ELECTRIC_SOURCE_ID`/`ELECTRIC_SECRET` on the
`pr` stage — deliberately, so a preview can never inherit the shared `dev`
credentials and proxy its shapes at another stage's data. The sync worker deploys
unconfigured, returns 503, and the web app falls back to its effect-atom fetches.

Both paths are now dead, not just `up`: Electric Cloud is gone, so there are no
environments left to reap and `scripts/electric-pr-branch.ts` has nothing to call.
What follows is kept as the record of what previews used to do — restoring live
sync in a preview means pointing it at a self-hosted Electric, not at Cloud.

The former lifecycle: an ephemeral Electric Cloud **environment** `pr-<n>` + a
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

- The web build always reads through the sync path, so with no source provisioned
  a preview's synced lists fall back to their effect-atom fetches. Provisioning
  the source is what would make live sync work in previews again.
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
_not_ held up is its other claim — "these are low-write control-plane tables, so the
extra WAL volume is negligible." `FULL` writes the entire old row into the WAL on top
of the new one, and since Electric Cloud consumes the slot over a direct connection,
every one of those bytes is billed PlanetScale egress.

Because the per-write multiplier is not negotiable, **the only lever on a synced table
is its write rate.** Before adding a hot writer to one, gate it:

- the alerting scheduler's per-minute claim lock lives in the _unpublished_
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
