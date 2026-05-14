# Service-map attribution

The service map at `apps/web/src/routes/service-map.tsx` is built entirely from attributes Tinybird MVs pre-extract at write time. If the MV's `SELECT` doesn't see the attribute key spelled the way it expects, the corresponding edge / node / badge **silently disappears** — there's no fallback, no warning. Use the exact keys and values in this file.

## What the map renders, and what feeds each part

| Rendered element | Source query | Required attribute | Lives on |
|---|---|---|---|
| Service-to-service edge | `service_map_edges_hourly_mv` | `peer.service` | Span (`Client` or `Producer` kind) |
| Service-to-DB edge | `service_map_db_edges_hourly_mv` | `db.system` (and `peer.service` for the main edge) | Span |
| Platform badge (Cloudflare / AWS / Railway / k8s) | `service_platforms_hourly_mv` | `cloud.platform`, `cloud.provider`, optional `faas.name`, optional `k8s.*` | Resource |
| Runtime icon (node / bun / deno / workerd / rust) | `service_platforms_hourly_mv` | `process.runtime.name` | Resource |
| SDK badge | `service_platforms_hourly_mv` | `maple.sdk.type` | Resource |
| Region (set but not yet rendered) | reserved | `cloud.region` | Resource |

Source: [packages/query-engine/src/ch/queries/service-map.ts](../../../../packages/query-engine/src/ch/queries/service-map.ts) and [packages/domain/src/tinybird/materializations.ts:415-422](../../../../packages/domain/src/tinybird/materializations.ts).

## Resource attributes — set once at startup

Every service must publish these on its OTel `Resource`. Skip any of them and the service appears on the map with empty badges or doesn't appear at all.

### TypeScript (Effect server)

Use `MapleServerSDK` from [lib/effect-sdk/src/server/index.ts](../../../../lib/effect-sdk/src/server/index.ts). Detection lives in [lib/effect-sdk/src/server/platform.ts](../../../../lib/effect-sdk/src/server/platform.ts) — it auto-resolves `cloud.*` / `faas.*` / `process.runtime.name` from `std-env` plus per-platform env vars. No manual setup needed beyond passing `serviceName` and `serviceVersion`.

### TypeScript (Cloudflare Workers)

Use `MapleCloudflareSDK` from [lib/effect-sdk/src/cloudflare/index.ts](../../../../lib/effect-sdk/src/cloudflare/index.ts). Hard-codes `cloud.provider="cloudflare"`, `cloud.platform="cloudflare.workers"`, `process.runtime.name="workerd"`, `maple.sdk.type="cloudflare"`.

### Rust

Use `build_resource` from [apps/ingest/src/otel.rs](../../../../apps/ingest/src/otel.rs):

```rust
use maple_ingest::otel::{build_resource, ResourceConfig};

let resource = build_resource(ResourceConfig {
    service_name: "ingest",
    service_version: env!("CARGO_PKG_VERSION"),
    service_instance_id: uuid::Uuid::new_v4().to_string(),
    deployment_env,
    internal_org_id,
});
```

The helper sets `process.runtime.name="rust"`, `maple.sdk.type="server"`, dual-emits `deployment.environment(.name)`, and runs the same platform-detection cascade as the TS SDK (Cloudflare → AWS Lambda → Railway → Vercel → Cloud Run → Render → Fly → k8s). Adding a new platform: extend `detect_platform()`, mirror the env-var sources used in `lib/effect-sdk/src/server/platform.ts`.

### Python (forward-looking)

Mirror the TS detection. Set the same keys with the same values — never invent Python-specific spellings.

## Span attributes — set per outbound call

| Call type | Span kind | Required attributes | Notes |
|---|---|---|---|
| Outbound HTTP / RPC | `Client` or `Producer` | `peer.service`; optional `server.address`, `http.request.method` | `peer.service` is the **logical** destination, not the host |
| Database call | any | `db.system` (e.g. `clickhouse`, `tinybird`, `postgres`) and `peer.service` (same value) | Both keys; `db.system` powers the DB-edge query, `peer.service` powers the main edge query |
| Message bus produce | `Producer` | `messaging.system`, `messaging.destination.name` | |

### TypeScript

```typescript
yield* Effect.annotateCurrentSpan("peer.service", "tinybird")
yield* Effect.annotateCurrentSpan("db.system", "tinybird")
```

Canonical example: [apps/api/src/services/WarehouseQueryService.ts](../../../../apps/api/src/services/WarehouseQueryService.ts) `executeSql` — sets both `db.system` and `peer.service` from the resolved warehouse backend.

### Rust

For the ingest forward to the downstream collector, use `forward_client_span`:

```rust
use maple_ingest::otel::forward_client_span;

let span = forward_client_span("collector", body_size, signal.path());
forward_to_collector(...).instrument(span).await
```

The helper bakes in `peer.service`, `otel.kind="client"`, and the `http.*` field set. `url.full` and `server.address` get recorded later inside `forward_to_collector` once the URL is resolved.

For new outbound peers, follow the same pattern: pick a name from the registry below (or extend it), and use `tracing::info_span!` with `"peer.service" = peer_name` plus `otel.kind = "client"`.

## Canonical `peer.service` registry

Keep these names consistent across services to avoid edge fragmentation on the map. If two services call the same peer with different names, the map shows two nodes.

| Peer name | What it is |
|---|---|
| `tinybird` | Tinybird hosted warehouse |
| `clickhouse` | Self-managed ClickHouse warehouse |
| `collector` | Maple ingest's downstream OTLP collector |
| `cloudflare-logpush` | Cloudflare logpush source |
| `clerk` | Clerk auth |
| `autumn` | Autumn metering |

Add new peers to this list as they're introduced — single source of truth.

## Anti-patterns

- **Don't use `server.address` instead of `peer.service`.** `server.address` is the host (e.g. `api.tinybird.co`); `peer.service` is the logical service identity. The map keys off the latter.
- **Don't set `peer.service` on `Server`-kind spans.** The MV filters them out. Server spans describe inbound work, which doesn't produce an outbound edge.
- **Don't invent platform values.** Use the OTel semconv-defined `cloud.platform` strings (`aws_lambda`, `cloudflare.workers`, `gcp_cloud_run`, etc.) so badges match across services.
- **Don't pick a different `process.runtime.name` than what TS emits for the same runtime.** TS uses `nodejs`, `bun`, `deno`, `workerd`. New Rust services use `rust`. New Python services use `python`. Mismatched values produce duplicate runtime icons.
- **Don't set `peer.service` only on success.** Set it at span declaration so the edge appears for failed calls too — that's how the map shows error rates per edge.

## Verification

After deploying a new service or peer:

1. Generate a representative request that exercises the outbound call.
2. Wait for the MV to hourly-aggregate (or check the in-progress hour via the raw fallback branch of [packages/query-engine/src/ch/queries/service-map.ts:92-112](../../../../packages/query-engine/src/ch/queries/service-map.ts:92)).
3. Open the service map and confirm the expected node + edges appear with the right badges.
4. If anything's missing, use `mcp__maple__inspect_trace` on a recent span to see the actual emitted attributes and compare to this rule.
