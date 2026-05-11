---
name: maple-telemetry-conventions
description: Maple's OpenTelemetry conventions — custom span attribute keys (`maple.*` vendor namespace, `query.context`, `db.statement.*`, `result.*`, `cache.*`, `tenant.*`), Title Case status codes (`Ok`/`Error`/`Unset`), resource attribute dual-emit (`deployment.environment` + `deployment.environment.name`), span kinds, Tinybird MV pre-extracted columns, loop-prevention filters, and sampling. Use whenever writing or reviewing instrumentation code in any language (TypeScript, Rust, Python) in this repo — adding `setAttribute`/`setAttributes`/`record`/`#[instrument(fields(...))]` calls, setting span status, configuring an OTLP exporter, defining a new resource attribute, or wiring a new query through `WarehouseQueryService.sqlQuery()`.
version: "1.0.0"
---

# Maple Telemetry Conventions

Reference for the **language-agnostic** OpenTelemetry conventions Maple uses across TypeScript (`apps/api`, Cloudflare workers in `lib/effect-sdk/`), Rust (`apps/ingest`), and future Python services. These conventions are load-bearing — Tinybird materialized views pre-extract certain attribute keys into columns, dashboards filter on Title Case status strings, and sampling-aware throughput math relies on the `SampleRate` column. Use the exact attribute spellings here in every language.

## When to apply

- Adding `setAttribute` / `Effect.annotateCurrentSpan` / `Span::current().record(...)` / `#[instrument(fields(...))]` to any code path
- Setting span status (Ok / Error / Unset)
- Wiring a new query through `WarehouseQueryService.sqlQuery()` (the `context` and `profile` options become span attributes)
- Configuring an OTLP exporter, tracer provider, or resource builder
- Introducing a new pre-extracted MV column or a new vendor attribute under `maple.*`
- Reviewing a PR that touches `apps/api/src/services/WarehouseQueryService.ts`, `apps/ingest/src/main.rs`, `apps/api/src/app.ts`, `lib/effect-sdk/src/cloudflare/`, or `packages/domain/src/tinybird/materializations.ts`

## Index

- `rules/span-attributes.md` — Master reference of every custom attribute key Maple emits, grouped by namespace, with file:line citations.
- `rules/status-and-kind.md` — Title Case status code rule (`Ok`/`Error`/`Unset`) and span kind conventions (`Server` / `Client` / `Internal`).
- `rules/resource-attributes.md` — `service.*` identity, `deployment.environment.name` resolution order, the legacy `deployment.environment` dual-emit, and `maple_org_id`.
- `rules/language-bindings.md` — Parallel TypeScript / Rust / Python snippets that emit the same attribute keys.
- `rules/mv-first-class-columns.md` — Which span and resource attributes Tinybird MVs pre-extract into columns (and the rule for adding new ones).
- `rules/loop-prevention.md` — The three guards that prevent Maple's self-traffic from creating a feedback loop: API `TracerDisabledWhen`, ingest loopback guard, sampling.

## Quick reference

| Topic | Rule |
|---|---|
| Status codes | Always Title Case: `"Ok"`, `"Error"`, `"Unset"`. Never `OK`, `ERROR`, `SUCCESS`, `FAILED`. |
| Vendor namespace | Custom attributes go under `maple.*`. Sub-namespaces: `maple.ingest.*`, `maple.cloudflare.*`. |
| Standard semconv | Use OTel semconv keys verbatim: `service.name`, `http.request.method`, `db.system`, `error.type`. |
| Org identity | `orgId` (camelCase) in TypeScript spans, `maple.org_id` (dotted) in Rust spans. Don't unify until MVs migrate. |
| Deployment env | Dual-emit `deployment.environment` + `deployment.environment.name`. Keep both until MV `coalesce()` migration lands. |
| Warehouse SQL spans | Every span from `WarehouseQueryService.executeSql` carries `db.system`, `db.statement`, `db.statement.fingerprint`, `db.duration_ms`, `result.rowCount`, `orgId`, `query.context`, `query.profile`. |
| Loop prevention | Never remove `HttpMiddleware.TracerDisabledWhen` (apps/api/src/app.ts:169-175) or the ingest loopback guard (apps/ingest/src/main.rs:499-514). |

## Canonical references (do not modify from this skill)

- `apps/api/src/services/WarehouseQueryService.ts:441-510` — `executeSql` span emission (the canonical example for TS).
- `apps/ingest/src/main.rs:516-540` — Resource attribute builder with the dual-emit.
- `apps/ingest/src/main.rs:843-861` — Server-kind span macro for OTLP inbound.
- `apps/ingest/src/main.rs:1132-1145` — Client-kind downstream forward span.
- `apps/api/src/app.ts:169-175` — `TracerDisabledWhen` filter.
- `lib/effect-sdk/src/cloudflare/index.ts` — `MapleCloudflareSDK` tracer setup.
- `packages/domain/src/tinybird/materializations.ts` — MV `SELECT` lists that pre-extract attribute keys into columns.
