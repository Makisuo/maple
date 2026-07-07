# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Maple is an OpenTelemetry observability platform built with TanStack Start (React meta-framework) and Tinybird as the backend data platform. It provides real-time visualization of traces, logs, and metrics from distributed systems.

## Local Dev Login

Sign in at `https://web.localhost` with the Clerk test account:

- Email: `david+clerk_test@gmail.com`
- Password: `Maple-Dev-Kx92qZ!`

Use this when you need an authenticated browser session to verify UI flows end-to-end.

## Toolchain (mise)

Tool versions (bun, node, rust, python) are pinned in the root [`mise.toml`](mise.toml) via
[mise-en-place](https://mise.en.dev) — one source of truth shared by local dev and CI (CI installs
them with `jdx/mise-action`). mise also auto-loads `.env.local` into your shell.

First-time setup:

```bash
curl https://mise.run | sh                        # install mise
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc     # activate (bash/fish supported too); restart shell
mise trust                                         # trust this repo's config (it defines env + tasks)
mise run setup                                     # install tools + JS deps + .env.local + portless CA
```

mise is optional — `bun dev` / `bun test` / etc. still work without it (you just don't get pinned
versions or env auto-load). When upgrading a runtime, bump it in `mise.toml` (keep `bun` in sync with
`packageManager` in `package.json`); CI follows automatically.

## Commands

```bash
# Development
bun dev              # Run all apps via turbo; each app's `dev` script invokes portless
                     # URLs: https://[<worktree>.]<app>.localhost
bun typecheck        # TypeScript type checking

# Skip portless for a single app (raw ports, no proxy)
bun --filter=@maple/web dev:app

# First-time setup (once per machine): install portless's local CA into your system trust store
npx portless trust

# Database (PlanetScale Postgres in prod; docker Postgres for wrangler dev)
bun db:up              # Start the dev Postgres (docker, port 5499) used by wrangler dev
bun db:migrate:local   # Apply drizzle migrations to the dev Postgres
                       # vitest needs neither — tests run embedded in-memory PGlite

# Testing
bun test             # Run Vitest tests

# Production
bun build            # Build for production
bun preview          # Preview production build

# Tinybird (data platform)
bun tinybird:dev     # Local development mode
bun tinybird:build   # Build Tinybird project
bun tinybird:deploy  # Deploy to Tinybird Cloud
```

## Architecture

### Tech Stack

- **Framework:** TanStack Start (React 19, Vite, Nitro)
- **Routing:** TanStack Router with file-based routing
- **Data Fetching:** TanStack React Query
- **Backend API:** Tinybird SDK for analytics queries
- **UI:** shadcn components (Base UI), Tailwind CSS 4, Nucleo Icons
- **Charts:** Recharts

### Directory Structure

```
src/
├── routes/           # File-based routing (TanStack Router)
│   ├── __root.tsx    # Root layout
│   └── traces/       # Trace pages ($traceId for dynamic routes)
├── api/tinybird/     # Server functions for Tinybird queries
├── components/
│   ├── ui/           # shadcn UI components
│   ├── dashboard/    # Dashboard-specific components
│   ├── traces/       # Trace visualization (flamegraph, span hierarchy)
│   └── logs/         # Log display components
├── tinybird/         # Auto-generated Tinybird type definitions
├── lib/              # Utilities (tinybird client, query-client, formatters)
└── hooks/            # React hooks
```

### Data Flow

1. React components in `/routes` define pages with file-based routing
2. Server functions in `/api/tinybird/` use `createServerFn` from TanStack Start
3. Server functions validate inputs with Zod and query Tinybird
4. React Query manages client-side caching and state

### Auto-Generated Files (do not edit manually)

- `src/routeTree.gen.ts` - Generated from route files

### Warehouse Query Pattern

**IMPORTANT:** Maple no longer uses Tinybird pipes/endpoints. All backend queries go through the ClickHouse DSL in `@maple/query-engine` and execute via `WarehouseQueryService.sqlQuery()`. The deployed Tinybird project contains only datasources and materialized views — zero pipes. The service routes to either Tinybird SDK or ClickHouse depending on org config.

The "engine" lives in `@maple/query-engine`, organized by concern (each is its own subpath export):

- `./ch` — the ClickHouse DSL (`from().select().where()`, `compile`, table/function defs) + `compilePipeQuery` (the named-query registry backing `WarehouseExecutor.query`).
- `./runtime` — the dashboard/alert lowering: validation, `QuerySpec` → CH, the `evaluate`/`evaluateRawSql` paths, cache-key builders, and the raw-SQL macro safety pass. Generic over tenant (`T extends QueryTenant`).
- `./execution` — the warehouse executor: `makeWarehouseExecutor(deps)` owns SQL run, retry, error mapping, client cache, OrgId scoping, and span instrumentation. The host app injects driver construction (`WarehouseClient`-style `createClient`) + per-org config resolution (`OrgWarehouseConfig`-style `resolveConfig`); the ClickHouse/Tinybird SDKs stay in `apps/api/src/lib/WarehouseQueryService.ts` (the only place those drivers are imported).
- `./caching` — `EdgeCacheService` (blob) + `BucketCacheService` (timeseries) behind a `CacheBackend` port; the Cloudflare Workers KV backend lives in `apps/api/src/lib/CacheBackendLive.ts` (keeps `globalThis.caches` out of the web/cli bundles).
- `./profiles` — query cost profiles (discovery/list/aggregation/explain/unbounded) → CH `SETTINGS`.
- `./observability` — high-level MCP/agent functions (`searchTraces`, `findErrors`, …) over the abstract `WarehouseExecutor` port.

The package **root barrel stays pure** (no driver/KV/DB imports) so it can feed the web/cli bundles; execution/caching/runtime are reachable only via their explicit subpaths, which only `apps/api` imports. `apps/api/src/lib/WarehouseQueryService.ts` is thin wiring (drivers + config resolution) that composes `makeWarehouseExecutor`; `apps/api/src/services/QueryEngineService.ts` is thin wiring (the edge/bucket caches) that composes the `./runtime` lowering.

Pattern (see `apps/api/src/routes/query-engine.http.ts` and `apps/api/src/services/QueryEngineService.ts` for examples):

1. **Define the query** as a DSL function in `packages/query-engine/src/ch/queries/*.ts` using `from(Table).select(...).where(...)` and `param.string/int/dateTime(name)` placeholders.
2. **Export it** from `packages/query-engine/src/ch/index.ts` so it's reachable via `import { CH } from "@maple/query-engine"`.
3. **Call it** from a service or route handler. Pass a `context` string in `SqlQueryOptions` so the executeSql span carries a semantic label (`query.context`) you can filter traces on:
    ```typescript
    const compiled = CH.compile(CH.myQuery({ limit: 50 }), {
    	orgId,
    	startTime, // ISO or Tinybird datetime string — resolveParam() quotes it
    	endTime,
    })
    const rows =
    	yield *
    	warehouse
    		.sqlQuery(tenant, compiled.sql, { profile: "list", context: "myQuery" })
    		.pipe(Effect.mapError(mapTinybirdError))
    const typedRows = compiled.castRows(rows)
    ```
4. **`sqlQuery` enforces `OrgId` scoping** — every query must include an `OrgId` filter (enforced by `WarehouseQueryService`). DSL queries satisfy this via `$.OrgId.eq(param.string("orgId"))` in their `.where()`.

`packages/domain/src/tinybird/endpoints.ts` is **type-only** — it holds `*Output` / `*Params` shapes for consumers that want to reference query result types. Do not add `defineEndpoint()` calls; they won't be deployed.

Never use raw `fetch()` calls to `/v0/sql` — always go through `warehouse.sqlQuery()` with a DSL-compiled query.

**ClickHouse 64-bit ints decode as strings (BYO-CH).** ClickHouse `FORMAT JSON` serializes `UInt64`/`Int64` columns (the result of `count()`, `sum()`, `uniqExact()`, …) as JSON **strings**, while managed Tinybird returns them as numbers. A BYO-ClickHouse org reads its own ClickHouse, so those columns arrive as strings. Any DSL query whose numeric outputs flow into a runtime `Schema.Number` (a `Schema.Class` constructor or an HTTP response encode) **must attach a `rowSchema`** built with `CH.CHNumber` (`Schema.Union([Schema.Finite, Schema.FiniteFromString])`) so `decodeRows` coerces them centrally — pass it as the third arg to `CH.compile(query, params, { rowSchema })`. Without it the string trips a `ParseError` that surfaces as a bare, message-less 500 for BYO-CH orgs only. See `cloudflareUsageRowSchema` and the `*OutputSchema` definitions in `packages/query-engine/src/ch/queries/service-map.ts`.

**Trace annotations on `WarehouseQueryService.executeSql`:** every SQL execution leaves a span carrying `db.query.text` (full SQL up to 16 KB), `db.query.length`, `db.query.fingerprint` (stable hash with literals normalized), `db.query.truncated`, `db.duration_ms`, `db.system.name`, `result.rowCount`, `orgId`, `tenant.userId`, `query.context`, and `query.profile`. When debugging slow queries, pull a trace and filter on these. (Spans recorded before 2026-06 carry the legacy `db.statement*`/`db.system` spellings; warehouse read paths coalesce both.)

## Environment Variables

```
TINYBIRD_HOST=http://localhost:7181   # Local dev or cloud endpoint
TINYBIRD_TOKEN=<token>                # Tinybird API token
```

## Application Database (PlanetScale Postgres)

Relational app state (issues, alert rules, dashboards, org config, API keys, …) lives in **PlanetScale Postgres**, one branch per stage (`main`=prd, `stg`, `pr-<n>`). Workers reach it through a **Cloudflare Hyperdrive** binding named `MAPLE_DB` (created in `apps/api/alchemy.run.ts`, bound to api/alerting/chat-agent). The schema is Drizzle (`packages/db/src/schema/`, `pgTable`, timestamptz/jsonb/boolean), with a single re-baselined migration history in `packages/db/drizzle/`.

- **Conventions:** app code keeps epoch-ms numbers and converts at the drizzle boundary (`new Date(ms)` on writes/wheres, `.getTime()`/`.toISOString()` on reads; `msToDate`/`dateToMs` in `apps/api/src/lib/time.ts` for nullables). Domain/HTTP contracts are unchanged (ms numbers / ISO strings). Never read driver write-result shapes — use `.returning()` + length. `count(*)`-style bigint aggregates need `::int` casts (postgres.js returns bigint as string).
- **Layers:** `DatabasePgLive` (Workers; per-`execute` short-lived postgres.js client — Workers TCP sockets are request-bound, Hyperdrive owns the warm pool) and `DatabasePgliteLive` (embedded PGlite for tests/evals/local non-worker code). Tests use `apps/api/src/lib/test-pglite.ts` (`createTestDb()` → in-memory PGlite + layer; raw SQL helpers take `$1` placeholders).
- **Migrations:** generated via `bun run --cwd packages/db db:generate`; applied by CI (`drizzle-kit migrate` against the branch's DIRECT port 5432, never a pooler) before `alchemy deploy`. Local wrangler-dev DB: `bun db:up && bun db:migrate:local`. PGlite applies them automatically at layer build.
- **PlanetScale-CLI scripts** (mint an ephemeral `pscale role` for a branch — `password` is Vitess-only — run, then revoke; uses the `pscale`-configured org unless `PLANETSCALE_ORG` is set; `PLANETSCALE_DATABASE` defaults to `maple`): `bun run --cwd packages/db ps:apply-schema <branch>` (drizzle migrate). The shared broker is `packages/db/scripts/planetscale-connection.ts`.
- **PR previews:** `scripts/planetscale-pr-branch.ts up|down <n>` (mirrors the Tinybird branch script) creates/deletes the `pr-<n>` branch and exports `MAPLE_PG_*` creds; wired into `deploy-pr-preview.yml`. Branch deletion on PR close is mandatory (PS-DEV billing + Hyperdrive config cap).
- **Ingest gateway** resolves ingest keys from the same Postgres (PSBouncer port 6432, no Hyperdrive) via `INGEST_KEY_STORE_BACKEND=postgres`.

## Key Conventions

- **Path Alias:** Use `@/` for imports (e.g., `@/components/ui/button`)
- **TypeScript:** Strict mode enabled with no unused variables
- **Server Functions:** Always validate inputs with Zod schemas
- **Effect Schema:** Use Effect Schema instead of Zod for all new schemas (route search params, server function validation). Use `Schema.toStandardSchemaV1()` to wrap Effect Schemas for TanStack Router's `validateSearch`. Use `Schema.optionalKey()` for optional fields in JSON-decoded HTTP schemas (domain models), and `Schema.optional()` only for JS-side schemas (route search params, MCP tool params) where `undefined` is a valid value.
- **Components:** Add UI components via `npx shadcn@latest add <component>`

### Nucleo Icons

Icons are sourced from the local Nucleo library and converted to React components in `apps/web/src/components/icons/`.

**Finding icons:** Query the Nucleo SQLite database:

```bash
sqlite3 "~/Library/Application Support/Nucleo/icons/data.sqlite3" \
  "SELECT id, name, set_id FROM icons WHERE klass='outline' AND grid=24 AND name LIKE '%search-term%';"
```

**Previewing:** Open the SVG to verify:

```bash
open "~/Library/Application Support/Nucleo/icons/sets/{set_id}/{id}.svg"
```

**Adding to project:** Copy an existing icon component from `apps/web/src/components/icons/`, replace SVG content with new icon (applying same transformations: currentColor, camelCase attrs), and add export to `index.ts`.

## Effect Patterns Reference

Use `/Users/maki/Documents/superwall/app` as the reference implementation for Effect patterns (HTTP middleware, services, layers). Effect source code is at `.context/effect/` (git subtree of [Effect-TS/effect-smol](https://github.com/Effect-TS/effect-smol)).

## Data Conventions

- **Span Status Codes:** Use title case (`"Ok"`, `"Error"`, `"Unset"`), not uppercase

## Documentation

End-user and platform documentation lives in `docs/`:

- `docs/sampling-throughput.md` — How Maple handles sampling-aware throughput metrics
- `docs/persistence.md` — Database persistence and migration operations
- `docs/sst-fork-workflow.md` — Running maple against a local SST fork, syncing with upstream, and opening PRs from fork branches
- `docs/local-mode.md` — Local mode (single Bun-compiled `maple` binary from `apps/cli`: CLI + OTLP-ingest/query server + bundled UI, talking to embedded chDB via `bun:ffi`→libchdb), the `/local/query` contract, dev workflow, and the 2-file release bundle
- `docs/tinybird-pr-branches.md` — Per-PR ephemeral Tinybird branches for preview deploys (`--last-partition` data, branch lifecycle wired into `deploy-pr-preview.yml`)
- `docs/otel-spec/` — Source-linked internal map of the OpenTelemetry specifications (traces, metrics, logs, OTLP, semconv, resource/config, propagation, stability, profiles/compat), snapshotted at spec v1.58.0. Use it for ingest-gateway OTLP-server compliance, self-instrumentation best practices, and UI data-semantics questions; start at `docs/otel-spec/README.md`

## Self-Observability (Trace Loop Prevention)

The Maple API traces itself via `@effect/opentelemetry` → ingest gateway → collector → Tinybird. This creates a feedback loop: viewing traces in the dashboard generates API calls, which create more traces.

**Mitigations already in place:**

- `HttpMiddleware.withTracerDisabledWhen()` skips `/health` and `OPTIONS` requests
- OTLP batch export (async, doesn't block requests)

**When modifying tracing code:**

- NEVER remove the `withTracerDisabledWhen` filter — it prevents noisy health check spans
- Be careful adding spans to high-frequency internal paths (e.g., auth token validation on every request)
- The OTLP export itself does NOT go through the API (it goes directly to the ingest gateway), so it won't create recursive traces

**`apps/ingest` self-instrumentation:**

The Rust ingest gateway self-instruments via OTLP/HTTP, exporting to its own `INGEST_FORWARD_OTLP_ENDPOINT` (so its traces flow through the same downstream collector → Tinybird as customer traffic). It identifies itself with `service.name="ingest"` (canonical — replaces the legacy Prometheus-scrape `ingest-proxy` label), `service.version` (`CARGO_PKG_VERSION`), `service.instance.id` (per-process UUID), `deployment.environment.name` (resolved from `MAPLE_ENVIRONMENT` first — matches the alchemy convention from `resolveDeploymentEnvironment(stage)` — then `RAILWAY_ENVIRONMENT_NAME`, then `DEPLOYMENT_ENV`, defaulting to `development`; also dual-emitted as the legacy `deployment.environment` because every Tinybird MV (`service_overview_spans_mv` et al.) still pre-extracts the legacy key — drop only after those MVs migrate to coalesce both), and `maple_org_id="internal"` (override via `MAPLE_INTERNAL_ORG_ID` env). Every inbound OTLP-forward and Cloudflare-logpush request creates a `Server`-kind span (`POST /v1/{signal}`, `POST /v1/logpush/...`) with HTTP semconv attributes (`http.request.method`, `http.route`, `http.request.body.size`, `http.response.status_code`, `error.type`); custom fields use the `maple.*` vendor namespace (`maple.signal`, `maple.org_id`, `maple.ingest.payload_format`, `maple.ingest.item_count`, etc.). The downstream forward is a child `Client`-kind span with `url.full`, `server.address`, and `http.response.status_code`. Span status is set via `otel.status_code` following the OTEL HTTP semconv rule for SERVER spans: **only 5xx is `Error`; 4xx client rejections are `Ok`** (see `otel_status_for_rejection` in `apps/ingest/src/main.rs`). This keeps the error dashboards (which only count `StatusCode='Error'`) attributing genuine ingest/forward failures — including the auth-resolver-unavailable 503 — while NOT flooding them with expected 4xx rejections (missing/invalid ingest key 401, billing-limit 402, throttle 429, oversized/undecodable payload). Those 4xx rejections stay fully observable via `http.response.status_code`, `error.type`, and the request metrics. This is safe because the span is exported to the downstream collector, not back through the ingest service. A startup loopback guard refuses to set up the exporter if `INGEST_FORWARD_OTLP_ENDPOINT` resolves to the gateway's own bind port. At high QPS, set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.1`. The gateway's own operational metrics (request/forward/export counters and histograms, in-flight gauges, WAL telemetry — defined in `apps/ingest/src/metrics.rs`) are also exported via OTLP: a `PeriodicReader` pushes them every 30s to `INGEST_FORWARD_OTLP_ENDPOINT/v1/metrics`, so they flow through the same collector → Tinybird pipeline as traces and land in the `metrics_*` datasources scoped to the `internal` org. There is no longer a `/metrics` Prometheus endpoint — `init_metrics` shares the loopback/skip-dev guard and the per-process `service.instance.id` with `init_tracing`.

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay (OpenAI has really generous limits), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| Model    | Cost | Intelligence | Taste |
| -------- | ---- | ------------ | ----- |
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 — it's effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent perspective.
- Never use Haiku model.
- Mechanics: gpt-5.5 is only reachable through the Codex through the `codex:codex-rescue` subagent (Codex plugin for Claude Code), my `~/.codex/config.toml` defaults to gpt-5.5.
- Use gpt-5.5 by `/codex:rescue` when you want Codex to:
    - investigate a bug
    - try a fix
    - continue a previous Codex task
    - take a faster or cheaper pass with a smaller model.
    - It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.
- Use gpt-5.5 by `/codex:transfer` to Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command. Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.
- Use gpt-5.5 by `/codex:status` to see running and recent Codex jobs for the current repository. Use it to:
    - check progress on background work
    - see the latest completed job
    - confirm whether a task is still running
- Use gpt-5.5 by `/codex:result` to show the final stored Codex output for a finished job. When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.
- Use gpt-5.5 by `/codex:cancel` to cancel an active background Codex job.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents by using Codex plugin for Claude Code (the model parameter only takes Claude models, so use a wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet'`, `effort: "low"` whose prompt instructs it to write a self-contained codex prompt, run `codex exec` via Bash, and return the result.
