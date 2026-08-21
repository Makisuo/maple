# Resource attributes

Resource attributes are set **once per process** on the OTel `Resource` and apply to every span and log that process emits. They identify the service and its deployment environment. The canonical reference implementation is the Rust ingest gateway's `init_tracing()` in `apps/ingest/src/main.rs:516-540`.

## Required identity attributes

| Key | Type | Source | Example | Notes |
|---|---|---|---|---|
| `service.name` | string | static (per service) | `"ingest"`, `"api"`, `"web"` | Canonical name. For the Rust gateway this is hard-coded to `"ingest"` and replaces the legacy Prometheus `ingest-proxy` label (CLAUDE.md: "**canonical — replaces the legacy Prometheus-scrape `ingest-proxy` label**"). |
| `service.namespace` | string | static (per service) | `"backend"`, `"ingest"`, `"client"` | Optional logical group for `service.name`. Extracted to the `ServiceNamespace` projection column (`service_overview_spans`, `trace_list_mv`, `logs_aggregates_hourly`) and surfaced in the services table + trace/log filters. Maple's own services split into three: **`backend`** (`maple-api`, `maple-agent`, `alerting`, `maple-cli`), **`ingest`** (the Rust gateway), **`client`** (`maple-web`). Set via the SDK `serviceNamespace` config field (TS) or `ResourceConfig.service_namespace` (Rust); **not** defaulted — external apps choose their own. |
| `service.version` | string | build-time | `env!("CARGO_PKG_VERSION")` in Rust, package version in TS | Semantic version; used for release-correlation. |
| `service.instance.id` | string | runtime | `uuid::Uuid::new_v4().to_string()` per process | Per-process UUID generated at startup. Lets dashboards distinguish replicas. |

## Deployment environment — read both, emit both

OTel renamed this attribute; the registry lists `deployment.environment.name` as stable and plain `deployment.environment` as deprecated ("Replaced by `deployment.environment.name`").

| Key | Status |
|---|---|
| `deployment.environment.name` | OTel-canonical — emit this one from new code |
| `deployment.environment` | Deprecated — Maple still emits it, and still **reads** it |

**Reading is the rule that matters.** Anything that pulls the environment out of `ResourceAttributes` — an MV body, a query-engine filter, a facet — uses the shared coalesce, never a bare map lookup:

```ts
import { DEPLOYMENT_ENV_SQL, deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
```

```sql
coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''),
         ResourceAttributes['deployment.environment'])
```

A bare lookup on either key alone drops the environment for half the fleet: our own SDKs dual-emit, a current OTel SDK sends only `.name`, an older one only the legacy key. `packages/domain/src/tinybird/semconv-renames.test.ts` fails if any MV extracts `DeploymentEnv` some other way. The same module carries `MESSAGING_DESTINATION_SQL` for the `messaging.destination` -> `messaging.destination.name` rename; any future rename Maple *keys on* belongs there too.

Source: `apps/ingest/src/main.rs:526-538`

```rust
.with_attribute(OtelKeyValue::new(
    "deployment.environment.name",
    deployment_env.clone(),
))
// Dual-emit the deprecated `deployment.environment` key: the MVs
// coalesce both spellings since migration 0020, but rows materialized
// before it — and pre-0020 BYO-ClickHouse schemas — still read the
// legacy key alone.
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

ClickHouse migration 0020 moved every MV onto the coalesce, so our own rollups no longer depend on the legacy emit. Two things still do: rows those MVs materialized **before** 0020 (they carry whatever the legacy key held and age out with the target TTL), and BYO-ClickHouse orgs whose schema is still pre-0020. Dropping the legacy emit is a follow-up gated on both, not a free cleanup.

## `maple_org_id` — internal service identity

| Key | Type | Source | Default | Notes |
|---|---|---|---|---|
| `maple_org_id` | string | env `MAPLE_INTERNAL_ORG_ID` | `"internal"` | Tags Maple's own services (so their self-traces don't pollute customer trace lists). Set per process. |

Source: `apps/ingest/src/main.rs:496-497, 539`.

This is intentionally **not** `maple.org_id` (the vendor-namespaced span attribute used for the *customer's* org). Resource-level `maple_org_id` is the org running this Maple service; span-level `maple.org_id` is the org sending data through it. The two underscore-vs-dot spellings prevent confusion in trace search.

## Effect SDK — Cloudflare workers

For TypeScript services running in Cloudflare Workers, resource attributes are set when constructing `MapleCloudflareSDK` in `packages/effect-sdk/src/cloudflare/index.ts`. The config object accepts `serviceName`, `serviceVersion`, and `attributes` for additional resource keys.

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
