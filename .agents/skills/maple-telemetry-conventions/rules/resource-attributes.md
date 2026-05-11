# Resource attributes

Resource attributes are set **once per process** on the OTel `Resource` and apply to every span and log that process emits. They identify the service and its deployment environment. The canonical reference implementation is the Rust ingest gateway's `init_tracing()` in `apps/ingest/src/main.rs:516-540`.

## Required identity attributes

| Key | Type | Source | Example | Notes |
|---|---|---|---|---|
| `service.name` | string | static (per service) | `"ingest"`, `"api"`, `"web"` | Canonical name. For the Rust gateway this is hard-coded to `"ingest"` and replaces the legacy Prometheus `ingest-proxy` label (CLAUDE.md: "**canonical — replaces the legacy Prometheus-scrape `ingest-proxy` label**"). |
| `service.version` | string | build-time | `env!("CARGO_PKG_VERSION")` in Rust, package version in TS | Semantic version; used for release-correlation. |
| `service.instance.id` | string | runtime | `uuid::Uuid::new_v4().to_string()` per process | Per-process UUID generated at startup. Lets dashboards distinguish replicas. |

## Deployment environment — dual emit ⚠

The most important rule in this file. Maple emits **both** the new and legacy keys:

| Key | Status |
|---|---|
| `deployment.environment.name` | OTel-canonical (new spec) |
| `deployment.environment` | Legacy — **keep until all Tinybird MVs migrate to `coalesce()` both keys** |

Source: `apps/ingest/src/main.rs:526-538`

```rust
.with_attribute(OtelKeyValue::new(
    "deployment.environment.name",
    deployment_env.clone(),
))
// Dual-emit the legacy `deployment.environment` key: every Tinybird MV
// (service_overview_spans_mv, service_map_*_mv, error_*_mv,
// logs_aggregates_hourly_mv, service_platforms_hourly_mv) still
// pre-extracts ResourceAttributes['deployment.environment'] at write
// time, so omitting it leaves DeploymentEnv='' for every ingest span
// and the services-table badge renders blank.
.with_attribute(OtelKeyValue::new("deployment.environment", deployment_env))
```

### Resolution order (priority)

The value comes from the first env var that resolves, in this order:

1. `MAPLE_ENVIRONMENT` — set by alchemy via `resolveDeploymentEnvironment(stage)` (`apps/api/alchemy.run.ts` and friends)
2. `RAILWAY_ENVIRONMENT_NAME` — Railway's free runtime label
3. `DEPLOYMENT_ENV` — manual override of last resort
4. Default: `"development"`

See `apps/ingest/src/main.rs:492-495` for the exact precedence:

```rust
let deployment_env = std::env::var("MAPLE_ENVIRONMENT")
    .or_else(|_| std::env::var("RAILWAY_ENVIRONMENT_NAME"))
    .or_else(|_| std::env::var("DEPLOYMENT_ENV"))
    .unwrap_or_else(|_| "development".to_string());
```

Any new service must follow the same priority order. Don't read `NODE_ENV` or `ENV` — they're not part of Maple's convention.

### When can the dual-emit be dropped?

When every MV in `packages/domain/src/tinybird/materializations.ts` that currently extracts `ResourceAttributes['deployment.environment']` switches to:

```sql
coalesce(
  ResourceAttributes['deployment.environment.name'],
  ResourceAttributes['deployment.environment']
) AS DeploymentEnv
```

…and the migration backfills any historical data. Until then, **never remove the legacy emit** — it leaves `DeploymentEnv=''` in the services table and the deployment-env badge renders blank.

## `maple_org_id` — internal service identity

| Key | Type | Source | Default | Notes |
|---|---|---|---|---|
| `maple_org_id` | string | env `MAPLE_INTERNAL_ORG_ID` | `"internal"` | Tags Maple's own services (so their self-traces don't pollute customer trace lists). Set per process. |

Source: `apps/ingest/src/main.rs:496-497, 539`.

This is intentionally **not** `maple.org_id` (the vendor-namespaced span attribute used for the *customer's* org). Resource-level `maple_org_id` is the org running this Maple service; span-level `maple.org_id` is the org sending data through it. The two underscore-vs-dot spellings prevent confusion in trace search.

## Effect SDK — Cloudflare workers

For TypeScript services running in Cloudflare Workers, resource attributes are set when constructing `MapleCloudflareSDK` in `lib/effect-sdk/src/cloudflare/index.ts`. The config object accepts `serviceName`, `serviceVersion`, and `attributes` for additional resource keys.

When wiring a new worker:

- Set `serviceName` to the service identifier (matching what dashboards filter on).
- Pass `attributes: { "deployment.environment.name": env, "deployment.environment": env, "maple_org_id": "internal" }` — same dual-emit rule applies.

## What goes here vs. on the span

| Information | Where |
|---|---|
| Identity of the service emitting the span | Resource attribute (`service.name`, `service.version`) |
| Deployment environment of the process | Resource attribute (`deployment.environment.name` + legacy) |
| Per-request data (org, user, route, status) | Span attribute (`orgId`, `tenant.userId`, `http.route`, etc.) |
| Per-request data that came in over the network | Span attribute (`maple.org_id`, `maple.signal`) |

**Rule of thumb:** if it's the same for every span this process emits, it's a resource attribute. If it varies per request, it's a span attribute.
