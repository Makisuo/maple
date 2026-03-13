# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Maple is an OpenTelemetry observability platform built with TanStack Start (React meta-framework) and Tinybird as the backend data platform. It provides real-time visualization of traces, logs, and metrics from distributed systems.

## Commands

```bash
# Development
bun dev              # Start dev server on port 3471
bun typecheck        # TypeScript type checking

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

### Tinybird SDK Pattern

**IMPORTANT:** Always use the Tinybird SDK with typed endpoints instead of raw SQL queries.

1. **Define endpoints** in `src/tinybird/endpoints.ts` using `defineEndpoint()` from `@tinybirdco/sdk`
2. **Register endpoints** in `src/lib/tinybird.ts` in the `pipes` configuration
3. **Export types** from `src/lib/tinybird.ts` for use in API files
4. **Use typed queries** in `src/api/tinybird/*.ts` via `getTinybird().query.<endpoint_name>()`

Example endpoint definition:
```typescript
export const myEndpoint = defineEndpoint("my_endpoint", {
  params: {
    start_time: p.dateTime().optional(),
  },
  nodes: [
    node({ name: "my_node", sql: `SELECT ... WHERE Timestamp >= {{DateTime(start_time)}}` }),
  ],
  output: {
    fieldName: t.string(),
  },
});
```

Never use raw `fetch()` calls to `/v0/sql` - always define typed endpoints for type safety and consistency.

When adding a new Tinybird endpoint, register it in **three** places:
1. Define in `packages/domain/src/tinybird/endpoints.ts`
2. Add pipe name to `packages/domain/src/tinybird-pipes.ts`
3. Register in `apps/api/src/services/TinybirdService.ts` pipes config + import

## Environment Variables

```
TINYBIRD_HOST=http://localhost:7181   # Local dev or cloud endpoint
TINYBIRD_TOKEN=<token>                # Tinybird API token
```

## Key Conventions

- **Path Alias:** Use `@/` for imports (e.g., `@/components/ui/button`)
- **TypeScript:** Strict mode enabled with no unused variables
- **Server Functions:** Always validate inputs with Zod schemas
- **Effect Schema:** Use Effect Schema instead of Zod for all new schemas (route search params, server function validation). Use `Schema.standardSchemaV1()` to wrap Effect Schemas for TanStack Router's `validateSearch`.
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

Use `/Users/maki/Documents/superwall/app` as the reference implementation for Effect patterns (HTTP middleware, services, layers). Effect source code is at `/Users/maki/Documents/superwall/app/.context/effect`.

## Data Conventions

- **Span Status Codes:** Use title case (`"Ok"`, `"Error"`, `"Unset"`), not uppercase

## Documentation

End-user and platform documentation lives in `docs/`:
- `docs/sampling-throughput.md` — How Maple handles sampling-aware throughput metrics
- `docs/persistence.md` — Database persistence and migration operations
- `docs/railway-deploy.md` — Railway deployment with Alchemy

## Self-Observability (Trace Loop Prevention)

The Maple API traces itself via `@effect/opentelemetry` → ingest gateway → collector → Tinybird. This creates a feedback loop: viewing traces in the dashboard generates API calls, which create more traces.

**Mitigations already in place:**
- `HttpMiddleware.withTracerDisabledWhen()` skips `/health` and `OPTIONS` requests
- OTLP batch export (async, doesn't block requests)

**When modifying tracing code:**
- NEVER remove the `withTracerDisabledWhen` filter — it prevents noisy health check spans
- Be careful adding spans to high-frequency internal paths (e.g., auth token validation on every request)
- The OTLP export itself does NOT go through the API (it goes directly to the ingest gateway), so it won't create recursive traces
