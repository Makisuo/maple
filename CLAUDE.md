# CLAUDE.md

Maple is an OpenTelemetry observability platform: TanStack Start (React 19, Vite) + Effect on the
backend, ClickHouse/Tinybird as the warehouse. Monorepo — `apps/*` (web, api, ingest, alerting, cli,
landing, …) and `packages/*` (query-engine, db, domain, ui, …).

## Local dev

Sign in at `https://web.localhost` with the Clerk test account `david+clerk_test@gmail.com` /
`Maple-Dev-Kx92qZ!` when you need an authenticated browser session.

```bash
bun dev                        # all apps via turbo → https://[<worktree>.]<app>.localhost
bun --filter=@maple/web dev:app # single app, raw port, no portless proxy
bun run test                   # Vitest via turbo (NOT `bun test` — that's Bun's own runner)
bun typecheck
bun run tinybird:manifest      # regenerate after editing datasources.ts
bun db:up && bun db:migrate:local   # docker Postgres for wrangler dev (vitest uses embedded PGlite)
bun run --cwd apps/api tinybird:deploy   # tinybird:dev / :build / :deploy live in apps/api
```

Toolchain (bun/node/rust/python) is pinned in [`mise.toml`](mise.toml); `mise run setup` does
first-time install + `.env.local` + portless CA. mise is optional but bump versions there when
upgrading a runtime (keep `bun` in sync with `packageManager`).

**After 10 PM local time, don't run heavy local compute** — no full test suite (`bun run test`),
repo-wide `bun typecheck`, full builds, cargo builds, or `bun dev` across all apps. Scope to what's
needed instead (single-package test/typecheck via `--filter`, a single dev app) and tell the user
which heavy commands were skipped so they can run them later.

## Warehouse queries

**No Tinybird pipes/endpoints exist.** All backend queries use the ClickHouse DSL in
`@maple/query-engine` and run through `WarehouseQueryService.sqlQuery()`, which routes to the
Tinybird SDK or ClickHouse per org config. Never `fetch()` `/v0/sql` directly.

Subpath exports: `./ch` (DSL + `compile`), `./runtime` (dashboard/alert lowering, `evaluate`,
cache keys), `./execution` (`makeWarehouseExecutor` — retry, error mapping, OrgId scoping, spans),
`./caching` (edge/bucket caches behind a `CacheBackend` port), `./profiles` (cost profiles →
`SETTINGS`), `./observability` (MCP/agent helpers). The **root barrel stays driver-free** so web/cli
can import it; only `apps/api` touches the other subpaths (`WarehouseQueryService.ts` injects the
drivers, `QueryEngineService.ts` the caches).

To add a query: define it in `packages/query-engine/src/ch/queries/*.ts` with
`from(Table).select(...).where(...)` + `param.*` placeholders, export from `src/ch/index.ts`, then:

```typescript
const compiled = CH.compile(CH.myQuery({ limit: 50 }), { orgId, startTime, endTime })
const rows =
	yield *
	warehouse
		.sqlQuery(tenant, compiled.sql, { profile: "list", context: "myQuery" })
		.pipe(Effect.mapError(mapTinybirdError))
const typedRows = compiled.castRows(rows)
```

- Every query **must** filter `OrgId` (`$.OrgId.eq(param.string("orgId"))`) — enforced at runtime.
- `context` labels the `executeSql` span (`query.context`), which also carries `db.query.text`,
  `db.query.fingerprint`, `db.duration_ms`, `result.rowCount`, `orgId`, `query.profile`.
- **64-bit ints arrive as strings on BYO-ClickHouse** (`count`/`sum`/`uniqExact`), as numbers on
  managed Tinybird. If the value flows into a `Schema.Number`, pass a `rowSchema` built with
  `CH.CHNumber` as `CH.compile(q, params, { rowSchema })` — otherwise BYO-CH orgs get a bare 500.
  See `packages/query-engine/src/ch/queries/service-map.ts`.
- `packages/domain/src/tinybird/endpoints.ts` is **type-only** — no `defineEndpoint()` calls.

## Application database (PlanetScale Postgres)

Relational state (issues, alert rules, dashboards, org config, keys) is Drizzle/`pgTable` in
`packages/db/src/schema/`, one PS branch per stage (`main`=prd, `stg`, `pr-<n>`), reached from
Workers via the Hyperdrive binding `MAPLE_DB`.

- App code keeps epoch-ms numbers and converts at the drizzle boundary (`new Date(ms)` writing,
  `.getTime()` reading; `msToDate`/`dateToMs` in `apps/api/src/lib/time.ts`). Never read driver
  write-result shapes — use `.returning()` + length. `count(*)` needs `::int` (bigint → string).
- Layers: `DatabasePgLive` (Workers, short-lived postgres.js client per `execute`) and
  `DatabasePgliteLive` (tests/local; `createTestDb()` in `apps/api/src/lib/test-pglite.ts`).
- Migrations: `bun run --cwd packages/db db:generate`; CI applies them against the branch's DIRECT
  port 5432 (never a pooler) before `alchemy deploy`. PGlite applies them at layer build.
- PR previews: `scripts/planetscale-pr-branch.ts up|down <n>`; deleting the branch on PR close is
  mandatory (billing + Hyperdrive config cap).
- The ingest gateway resolves ingest keys from the same Postgres via PSBouncer (6432, no Hyperdrive).

## Conventions

- **Imports:** `@/` path alias. `src/routeTree.gen.ts` is generated — don't edit.
- **Schemas:** Effect Schema, not Zod, for everything new. Wrap with `Schema.toStandardSchemaV1()`
  for TanStack Router `validateSearch`. `Schema.optionalKey()` for JSON-decoded HTTP/domain schemas;
  `Schema.optional()` only where `undefined` is a real JS value (search params, MCP tool params).
- **Effect:** source is vendored at `.context/effect/` (subtree of Effect-TS/effect-smol).
- **Span status codes:** Title case — `"Ok"`, `"Error"`, `"Unset"`.
- **UI:** shadcn/Base UI + Tailwind 4 (`npx shadcn@latest add <component>`), Recharts, Nucleo icons.
  Find an icon in the local Nucleo DB, then port it into `apps/web/src/components/icons/` by copying
  an existing component (currentColor, camelCase attrs) and exporting it from `index.ts`:
    ```bash
    sqlite3 "~/Library/Application Support/Nucleo/icons/data.sqlite3" \
      "SELECT id, name, set_id FROM icons WHERE klass='outline' AND grid=24 AND name LIKE '%search%';"
    ```

## Self-observability (trace loop prevention)

The API traces itself through the ingest gateway, so dashboard traffic generates traces. Keep
`HttpMiddleware.withTracerDisabledWhen()` (skips `/health` + `OPTIONS`) and be careful adding spans
to per-request hot paths like token validation. OTLP export bypasses the API, so it can't recurse.

`apps/ingest` (Rust) self-instruments over OTLP/HTTP to its own `INGEST_FORWARD_OTLP_ENDPOINT`
(startup guard refuses a loopback endpoint), as `service.name="ingest"`, `maple_org_id="internal"`,
and `deployment.environment.name` **dual-emitted** as the legacy `deployment.environment` because
the Tinybird MVs still pre-extract the old key. Custom fields use the `maple.*` namespace. Span
status follows OTEL HTTP semconv for SERVER spans: **only 5xx is `Error`, 4xx rejections are `Ok`**
(`otel_status_for_rejection` in `apps/ingest/src/main.rs`) so error dashboards aren't flooded by
expected 401/402/429s. Operational metrics (`apps/ingest/src/metrics.rs`) push via OTLP every 30s —
there is no Prometheus `/metrics` endpoint. At high QPS set `OTEL_TRACES_SAMPLER=parentbased_traceidratio`.

## Docs (`docs/`)

`api-v2.md` (v2 public API spec) · `sampling-throughput.md` · `persistence.md` ·
`sst-fork-workflow.md` · `local-mode.md` (single-binary CLI + embedded chDB) ·
`tinybird-pr-branches.md` · `otel-spec/` (OTel spec map @ v1.58.0 — start at its README).

## Picking models for subagents and workflows

Higher = better. Cost reflects what I actually pay, not list price.

| Model    | Cost | Intelligence | Taste |
| -------- | ---- | ------------ | ----- |
| gpt-5.6  | 10   | 9            | 7     |
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

- Defaults, not limits — escalate to a smarter model without asking if output misses the bar.
  When axes conflict: intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, migrations, data analysis): gpt-5.5.
- User-facing work (UI, copy, API design) needs taste ≥ 7. Reviews: fable-5 or opus-4.8.
- **Never use Haiku.**
- Claude models run via the Agent/Workflow `model` param. gpt-5.5 is only reachable through the
  Codex plugin (`/codex:rescue`, `:status`, `:result`, `:cancel`, `:transfer`); inside a workflow,
  wrap it — spawn a `model: 'sonnet'`, `effort: 'low'` agent that runs `codex exec` via Bash.
