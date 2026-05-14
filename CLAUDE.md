# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Maple is an OpenTelemetry observability platform built with TanStack Start (React meta-framework) and Tinybird as the backend data platform. It provides real-time visualization of traces, logs, and metrics from distributed systems.

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

**IMPORTANT:** Maple no longer uses Tinybird pipes/endpoints. All backend queries go through the ClickHouse DSL in `@maple/query-engine` and execute via `WarehouseQueryService.sqlQuery()` (defined in `apps/api/src/services/WarehouseQueryService.ts`). The deployed Tinybird project contains only datasources and materialized views — zero pipes. The service routes to either Tinybird SDK or ClickHouse depending on org config.

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
    const rows = yield * warehouse
    	.sqlQuery(tenant, compiled.sql, { profile: "list", context: "myQuery" })
    	.pipe(Effect.mapError(mapTinybirdError))
    const typedRows = compiled.castRows(rows)
    ```
4. **`sqlQuery` enforces `OrgId` scoping** — every query must include an `OrgId` filter (enforced by `WarehouseQueryService`). DSL queries satisfy this via `$.OrgId.eq(param.string("orgId"))` in their `.where()`.

`packages/domain/src/tinybird/endpoints.ts` is **type-only** — it holds `*Output` / `*Params` shapes for consumers that want to reference query result types. Do not add `defineEndpoint()` calls; they won't be deployed.

Never use raw `fetch()` calls to `/v0/sql` — always go through `warehouse.sqlQuery()` with a DSL-compiled query.

**Trace annotations on `WarehouseQueryService.executeSql`:** every SQL execution leaves a span carrying `db.statement` (full SQL up to 16 KB), `db.statement.length`, `db.statement.fingerprint` (stable hash with literals normalized), `db.statement.truncated`, `db.duration_ms`, `db.system`, `result.rowCount`, `orgId`, `tenant.userId`, `query.context`, and `query.profile`. When debugging slow queries, pull a trace and filter on these.

## Environment Variables

```
TINYBIRD_HOST=http://localhost:7181   # Local dev or cloud endpoint
TINYBIRD_TOKEN=<token>                # Tinybird API token
```

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

The Rust ingest gateway self-instruments via OTLP/HTTP, exporting to its own `INGEST_FORWARD_OTLP_ENDPOINT` (so its traces flow through the same downstream collector → Tinybird as customer traffic). It identifies itself with `service.name="ingest"` (canonical — replaces the legacy Prometheus-scrape `ingest-proxy` label), `service.version` (`CARGO_PKG_VERSION`), `service.instance.id` (per-process UUID), `deployment.environment.name` (resolved from `MAPLE_ENVIRONMENT` first — matches the alchemy convention from `resolveDeploymentEnvironment(stage)` — then `RAILWAY_ENVIRONMENT_NAME`, then `DEPLOYMENT_ENV`, defaulting to `development`; also dual-emitted as the legacy `deployment.environment` because every Tinybird MV (`service_overview_spans_mv` et al.) still pre-extracts the legacy key — drop only after those MVs migrate to coalesce both), and `maple_org_id="internal"` (override via `MAPLE_INTERNAL_ORG_ID` env). Every inbound OTLP-forward and Cloudflare-logpush request creates a `Server`-kind span (`POST /v1/{signal}`, `POST /v1/logpush/...`) with HTTP semconv attributes (`http.request.method`, `http.route`, `http.request.body.size`, `http.response.status_code`, `error.type`); custom fields use the `maple.*` vendor namespace (`maple.signal`, `maple.org_id`, `maple.ingest.payload_format`, `maple.ingest.item_count`, etc.). The downstream forward is a child `Client`-kind span with `url.full`, `server.address`, and `http.response.status_code`. Span status is set to `Ok`/`Error` via `otel.status_code` so dashboards' error analytics (which only count `StatusCode='Error'`) attribute failures correctly. This is safe because the span is exported to the downstream collector, not back through the ingest service. A startup loopback guard refuses to set up the exporter if `INGEST_FORWARD_OTLP_ENDPOINT` resolves to the gateway's own bind port. At high QPS, set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.1`. Metrics are still on the `/metrics` Prometheus endpoint — the new pipeline only carries traces today.
