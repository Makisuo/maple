# ElectricSQL sync (TanStack DB)

Maple syncs a small set of **relational control-plane tables** to the web app in
real time using [ElectricSQL](https://electric.ax) shapes fronted by
[TanStack DB](https://tanstack.com/db) collections. Warehouse/analytics data
(traces, logs, metrics via `@maple/query-engine`) is **not** synced — it stays on
the effect-atom + `WarehouseQueryService` path.

The feature is **off by default** (`VITE_ELECTRIC_SYNC` unset). The dashboards
vertical is fully implemented and is the reference for the remaining consumers.

## How it fits together

```
Browser (apps/web)
  TanStack DB collections, one set per active org
    read:  ShapeStream → GET {api}/api/sync/shape?shape=<name>&offset=…&handle=…
           (mapleShapeFetch injects the Clerk / self-hosted bearer)
    write: existing typed HTTP endpoints (Electric is read-path only)

apps/api Worker — /api/sync/shape  (electric-sync.http.ts, a raw HttpRouter)
  auth: API key, else Clerk/self-hosted tenant resolution (same as ApiAuthorizationLayer)
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

### Shapes (server-pinned whitelist, `electric-sync.http.ts`)

| shape | table | extra WHERE (besides org scope) |
|---|---|---|
| `dashboards` | dashboards | — |
| `alert_rules` | alert_rules | — |
| `alert_rule_states` | alert_rule_states | — |
| `alert_incidents` | alert_incidents | — |
| `error_issues` | error_issues | `"archived_at" IS NULL` |
| `actors` | actors | — |
| `open_error_incidents` | error_incidents | `"status" = 'open'` |

Shape `where`/columns are **immutable** — changing a pinned predicate forces a
full re-sync for every client. If you must change one, version the shape name
(e.g. `error_issues.v2`) so old clients keep working during a deploy overlap.

## Local development

1. `bun db:up` starts the docker Postgres (now with `wal_level=logical`) and the
   `electric` service (port 3473) — see `docker-compose.development.yml`.
   If your Postgres volume predates the `wal_level` change, recreate it:
   `docker compose -f docker-compose.development.yml up -d --force-recreate postgres electric`.
2. `bun db:migrate:local` applies migrations, including `0009_electric_publication`.
3. `.env.local`: `ELECTRIC_URL=http://localhost:3473` (already in `.env.example`).
4. Run the app (`bun dev`) with `VITE_ELECTRIC_SYNC=1` to exercise the sync path.

Smoke-test the shape endpoint directly (no proxy):
`curl -g 'http://localhost:3473/v1/shape?table=dashboards&offset=-1'`.

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
5. **Env:** set `ELECTRIC_URL`, `ELECTRIC_SOURCE_ID`, `ELECTRIC_SECRET`
   (wired in `apps/api/alchemy.run.ts` + `Env.ts`), then `alchemy deploy`.
   With `ELECTRIC_URL` unset the proxy returns 503 and the app stays on effect-atom.
6. Validate initial per-org snapshot sizes before flipping `VITE_ELECTRIC_SYNC=1`
   on the web deploy.

## Adding a synced table later

1. New guarded Drizzle migration: `ALTER PUBLICATION electric_publication_default ADD TABLE "<t>";`
   plus `ALTER TABLE "<t>" REPLICA IDENTITY FULL;` (wrap in the same
   `DO $$ … EXCEPTION … END $$` guard as `0009` so PGlite tests don't abort).
2. Add the shape to the whitelist in `electric-sync.http.ts`.
3. Add a collection under `apps/web/src/lib/collections/` (model on `dashboards.ts`)
   and register it in `org-collections.ts`.

## Status / remaining work

**Done and verified**
- Infra: docker `electric` + `wal_level=logical`; `0009_electric_publication`
  (applies via both `drizzle-kit migrate` and the PGlite test path — see
  `packages/db/src/migrations.test.ts`).
- Shape proxy with org-scoping + client-param pinning
  (`apps/api/src/routes/electric-sync.http.ts`; the security-critical pinning is
  unit-tested in `electric-sync.test.ts`).
- txid capture: dashboards (all writes), alert rules (create/update/delete), and
  error issues `heartbeat`/`assign`/`setSeverity`.
- **Dashboards** collection + `useDashboardStore` collection path (behind the flag),
  full end-to-end: proven against a live Electric 1.6.2 instance locally.

**Remaining (follow-ups)**
- **Alerts + error-issue read consumers (Phase 6):** build `collections/alerts.ts`
  and `collections/errors.ts` (single-table shapes → client-side live-query joins:
  `alert_rules ⟕ alert_rule_states`; `error_issues ⟕ actors ⟕ open_error_incidents`),
  then swap `listRulesAtom` / `listIncidentsAtom` / the issues-page `listIssues`
  atom for live queries — following the dashboards template.
- **txid on the transition-composed error mutations** (`transitionIssue`,
  `claimIssue`, `releaseIssue`): these compose `applyTransition` (multiple
  `error_issues` writes), so they currently return no `txid` and clients drop
  optimistic state on the next synced update instead of on the exact txn. Capture
  the last write's txid when finalizing Phase 6.
- **Row-volume check** before enabling error-issue/alert-incident sync: confirm
  per-org non-archived `error_issues` and `alert_incidents` counts are bounded; if
  not, add an archival tick or keep terminal-state tabs on paged effect-atom reads.
```
