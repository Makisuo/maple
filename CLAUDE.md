# CLAUDE.md

Maple is an OpenTelemetry observability platform: TanStack Start (React 19, Vite) + Effect on the
backend, ClickHouse/Tinybird as the warehouse.

## Workspace layout

Three roots, and the split is a rule, not a habit:

- **`apps/*`** — deployables (web, api, ingest, alerting, cli, landing, …).
- **`packages/*`** — shared code that **knows Maple**: its schema, tables, API, or product.
  `domain`, `query-engine`, `ui`, `db`, `auth`, `effect-sdk`, `browser`, …
- **`lib/*`** — libraries with **zero Maple knowledge**, extractable to their own repo tomorrow.
  `clickhouse-builder`, `effect-cloudflare`, `effect-db`, `effect-router`, `cache`,
  `otel-helpers`, `unitflow`.

The test for `lib/` is "could this ship as a standalone OSS library?" — not "is it published?"
and not "did we write it?". Publishability is a `package.json` fact, not a directory fact:
`packages/effect-sdk` and `packages/browser` are both published. **New packages go in
`packages/` unless they pass the lib test.**

Anything in `lib/` that starts importing `@maple/domain` has stopped qualifying — move it to
`packages/` rather than weakening the rule.

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

## Warehouse queries

**No Tinybird pipes/endpoints exist.** All backend queries use the ClickHouse DSL in
`@maple/query-engine` and run through `WarehouseQueryService.compiledQuery()`, which routes to the
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
const rows = yield * warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "myQuery" })
```

`compiledQuery` runs the SQL and decodes rows through the query's `rowSchema` (if declared);
`profile` defaults to `"aggregation"` when omitted (`"unbounded"` is the explicit opt-out). There is
no `castRows` — a cast that looked type-safe hid wire-format drift.

- Every query **must** filter `OrgId` (`$.OrgId.eq(param.string("orgId"))`) — enforced at runtime.
- `context` labels the `executeSql` span (`query.context`), which also carries `db.query.text`,
  `db.query.fingerprint`, `db.duration_ms`, `result.rowCount`, `orgId`, `query.profile`.
- **64-bit ints arrive as numbers on every backend**: ClickHouse-protocol clients pin
  `output_format_json_quote_64bit_integers=0` (`BackendDialect.unquote64BitIntegers`), matching the
  Tinybird SDK. Two rules remain: (1) identity UInt64s (hashes/ids) must be `toString()`-wrapped in
  the SELECT — values above 2^53 corrupt as JS numbers; the SQL-catalog e2e sweep enforces this.
  (2) `rowSchema`s still use `CH.CHNumber`, never `Schema.Number`, so a gateway/readonly cluster
  that refuses the setting (quoted wire) keeps decoding.
- `CH.compile` reports failures in the Effect channel, and **the unrun Effect is what you hand
  the warehouse** — `warehouse.compiledQuery(tenant, CH.compile(q, params), …)`. Never
  `Effect.orDie` a compile at a call site: the executor already does it once, in
  `resolveCompiledQuery`, because a query built from Maple's own definitions that will not
  compile is a bug. Wherever a **request field** reaches a `param.*` value or a column
  comparison (a cursor, a bucket size, a time bound), constrain it at the HTTP boundary —
  `TinybirdDateTime`, `BucketSeconds`, `WarehouseDateTime` — so a bad value is a 400 rather than
  a 500. `bucket_seconds: 1.5` and a forged replay cursor were both the latter. A value that
  genuinely cannot be pre-validated is the one case for `Effect.mapError` at the call site, into
  a failure the route already returns.
- `packages/domain/src/tinybird/endpoints.ts` is **type-only** — no `defineEndpoint()` calls.

## Application database (PlanetScale Postgres)

Relational state (issues, alert rules, dashboards, org config, keys) is Drizzle/`pgTable` in
`packages/db/src/schema/`, one PS branch per deployed stage (`main`=prd, `stg`), reached from
Workers via the Hyperdrive binding `MAPLE_DB`.

- App code keeps epoch-ms numbers and converts at the drizzle boundary — use `msToDate` /
  `dateToMs` from `apps/api/src/platform/time.ts` rather than bare `new Date(ms)` /
  `.getTime()`, including inside Promise-land helpers. Never read driver write-result shapes
  — use `.returning()` + length. `count(*)` needs `::int` (bigint → string).
- Layers: `DatabasePgLive` (Workers) and `DatabasePgliteLive` (tests/local; `createTestDb()` in
  `apps/api/src/platform/test-pglite.ts`).
- One Postgres connection per invocation — request, cron tick, or Workflow run — created lazily and
  closed at the boundary, which is Cloudflare's documented Hyperdrive shape. The single primitive is
  `makePgConnectionScope` in `apps/api/src/platform/pg-connection-scope.ts`; `pgConnectionMiddleware`
  installs it for HTTP, `withPgConnectionScope` for cron. Sockets are request-bound on Workers, so a
  connection may be reused freely WITHIN an invocation but must never outlive it. `max` is 5
  (a ceiling, not a reservation — capping it at 1 serialized cron ticks and cost 3–6x on p50) and the
  dial is bounded so a stall lands as `error.type = CONNECT_TIMEOUT` instead of hanging.
- Migrations: `bun run --cwd packages/db db:generate`; CI applies them against the branch's DIRECT
  port 5432 (never a pooler) before `alchemy deploy`. PGlite applies them at layer build.
- **PR preview deploys are disabled** (2026-08, cost). `deploy-pr-preview.yml` triggers on the
  `closed` event only, so it tears down pre-cutover stacks and never deploys a new one; restore
  `types: [opened, synchronize, reopened, closed]` to re-enable.
- **PR previews have no application database** either (PS-DEV branches billed continuously and
  ate the Hyperdrive config cap) — this is the state previews return to when re-enabled.
  `resolveDatabaseMode` in
  `packages/infra/src/cloudflare/stage.ts` returns `"none"` for `pr`, so no `MAPLE_DB` is bound
  and `DatabasePgLive` fails every query with a `DatabaseError` — DB-backed routes 500, the rest
  of the preview works. To restore: return `"managed"` for `pr` and re-add the PlanetScale +
  Electric steps to `.github/workflows/deploy-pr-preview.yml` (the scripts are kept, dormant).
- The ingest gateway resolves ingest keys from the same Postgres via PSBouncer (6432, no Hyperdrive).

## Conventions

- **Imports:** `@/` path alias. `src/routeTree.gen.ts` is generated — don't edit.
- **Schemas:** Effect Schema, not Zod, for everything new. Wrap with `Schema.toStandardSchemaV1()`
  for TanStack Router `validateSearch`. `Schema.optionalKey()` for JSON-decoded HTTP/domain schemas;
  `Schema.optional()` only where `undefined` is a real JS value (search params, MCP tool params).
- **Types:** `Record<string, any>` is banned at `error` (`maple/no-record-string-any`, a local oxlint
  JS plugin in `scripts/oxlint-plugins/maple.mjs`) and the repo is at zero — keep it there. Generic
  constraints (`<T extends Record<string, any>>`) are exempt: `unknown` does not work in that
  position. `typescript/no-explicit-any` is `warn` (75 left, all outside `lib/`). Both rules are off
  under `lib/**`, whose builder DSLs (`clickhouse-builder`, `unitflow`, `effect-cloudflare`) use
  `any` as a type-level placeholder in variance positions. `Record<string, unknown>` is _not_ banned —
  it forces narrowing at every read, which is the point.
- **Effect:** source is vendored at `.context/effect/` (subtree of Effect-TS/effect-smol).
- **Effect errors:** new expected failures always use `Schema.TaggedError`, including internal-only
  failures; `Data.TaggedError` is legacy and is not a precedent for new Maple code. Give every
  failure a namespaced tag, `message`, and useful schema-backed context (`Schema.Defect()` for an
  unknown cause), then keep it in the typed Effect error channel. At HTTP/RPC boundaries, define
  public failures in the domain contract and preserve their distinct tags until the route's existing
  error mapper/envelope handles them; use `catchTag`/`catchTags` for deliberate remapping. Plain
  `Error`, thrown failures, route-local `Data.TaggedError`, and early generic error/response mapping
  bypass this flow. Valid entity IDs in error context use their branded domain schemas; rejected
  undecodable inputs use an explicitly named `raw*` string and must never be cast into a brand.
  Unexpected defects alone belong in `catchDefect`/the unexpected-error envelope.
- **Alchemy:** read `node_modules/alchemy/src/` — the package ships its own TypeScript source,
  so it always matches the version actually running. There is deliberately no vendored copy:
  `.context/alchemy-effect` held `alchemy-effect@0.11.0`, a package upstream renamed into
  `alchemy@2.x` (now `packages/alchemy`) and stopped publishing in April 2026. Four months on
  it had diverged exactly where it mattered — it has `AWS/StageConfig.ts` where the real
  package has `AWS/Environment.ts` + `AWS/AuthProvider.ts` — and a code review cited its line
  numbers as fact for a bug in the live code.
- **LLM core:** `@opencode-ai/ai` — opencode's Effect-native LLM core, on npm and pinned exactly
  (`0.0.0-beta-18050`; the `dev`/`beta` channels carry no semver, so a bump is a read of the diff).
  Only `apps/api` depends on it, and every piece of Maple behaviour — layer wiring, the Workers AI
  binding shim, model/provider selection, error mapping — lives at the seam in
  `apps/api/src/platform/Llm.ts`, never in a wrapper around the package.
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
and `deployment.environment.name` **dual-emitted** as the deprecated `deployment.environment`
(the MVs coalesce both since migration 0020 — see `DEPLOYMENT_ENV_SQL` in
`packages/domain/src/tinybird/semconv-renames.ts`, which is where every
renamed-key coalesce belongs; the dual-emit remains for rows already
materialized under the old key and for pre-0020 BYO-ClickHouse schemas). Custom fields use the `maple.*` namespace. Span
status follows OTEL HTTP semconv for SERVER spans: **only 5xx is `Error`, 4xx rejections are `Ok`**
(`otel_status_for_rejection` in `apps/ingest/src/main.rs`) so error dashboards aren't flooded by
expected 401/402/429s. Operational metrics (`apps/ingest/src/metrics.rs`) push via OTLP every 30s —
there is no Prometheus `/metrics` endpoint. At high QPS set `OTEL_TRACES_SAMPLER=parentbased_traceidratio`.

## Docs (`docs/`)

`api-v2.md` (v2 public API spec) · `error-issue-lifecycle.md` (how an error becomes an issue,
gets diagnosed, fixed and verified — read before touching `apps/api/src/services/errors/`) ·
`sampling-throughput.md` · `persistence.md` ·
`warehouse-rollups.md` (MV/rollup tiering contract — read before adding a materialized view) ·
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
