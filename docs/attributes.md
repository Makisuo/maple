# Attributes Maple recognizes

Maple stores every OTel attribute you send verbatim, but a curated set get special treatment — pre-extracted into fast columns at ingest, exposed as short filter aliases, rendered as colored badges, used to draw the service map, or scored higher in the attribute chip strip. This page is organized by **feature you want to unlock**, so you can pick the attributes worth instrumenting and skip the rest.

Most of these follow the [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/) — if your SDK emits standard attributes you usually don't need to do anything extra.

## Service identity

The bare minimum every span needs. `service.name` is the primary axis Maple groups by — without it spans go to a synthetic `unknown_service` bucket.

| Attribute             | Example                                | What Maple does with it                                                                                                                                                       |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.name`        | `api`, `ingest`, `web`                 | **Required.** Primary grouping for services list, service map, dashboards, alerts. Filter alias: `service`.                                                                   |
| `service.version`     | `1.4.2`, `c0b92f68`                    | Per-version slices on service overview. Auto-skipped from chip strip but always queryable.                                                                                    |
| `service.namespace`   | `payments`                             | Logical grouping above `service.name`. Auto-skipped from chip strip.                                                                                                          |
| `service.instance.id` | UUID per process                       | Distinguishes replicas of the same service. Auto-skipped from chip strip.                                                                                                     |

## Deployment & version tracking

Tag every span with these and you get per-environment and per-version slices for free across the services table, service map, and per-service overview.

| Attribute                     | Example      | What Maple does with it                                                                                          |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `deployment.environment`      | `production` | Filterable everywhere; per-env throughput / latency / error rate; environment chips in span detail.              |
| `deployment.environment.name` | `production` | Accepted as an alias for `deployment.environment` in infrastructure queries.                                     |
| `deployment.commit_sha`       | `c0b92f68`   | Per-version metrics in service overview; exposed as the `commit_sha` discovery facet so you can pivot by deploy. |

Maple's SDKs currently dual-emit both `deployment.environment` and `deployment.environment.name` — they're treated as the same value. Emitting either is fine. In the search bar, `env`, `environment`, and `commit_sha` are short aliases — see [Filter aliases](#filter-aliases) below.

## Span status & kind

Two span-level fields (not attributes) that Maple reads directly. Both spellings are load-bearing — typos silently drop spans out of dashboards.

### Status code — **Title Case is required**

| Value     | When to set it                          |
| --------- | --------------------------------------- |
| `Ok`      | Successful operation                    |
| `Error`   | Failed operation                        |
| `Unset`   | OTel default; status not explicitly set |

Use the strings `"Ok"`, `"Error"`, `"Unset"` exactly. The error-rate widget filters via `WHERE StatusCode = 'Error'` — uppercase (`ERROR`) or lowercase (`error`) variants silently produce zero rows. Most OTel SDKs serialize the status enum correctly; just don't hand-stamp the wire value.

The trace UI maps these to colored badges via `statusStyles` in [span-detail-panel.tsx:43-47](../apps/web/src/components/traces/span-detail-panel.tsx).

### Span kind

| Value       | Set it on                                                                  |
| ----------- | -------------------------------------------------------------------------- |
| `Server`    | Inbound network request handlers (HTTP/gRPC servers)                       |
| `Client`    | Outbound network calls (HTTP clients, DB drivers, message producers)       |
| `Producer`  | Queue producers                                                            |
| `Consumer`  | Queue consumers                                                            |
| `Internal`  | In-process work (default; cache lookups, validation, query compilation)    |

`Client` spans get a small outgoing-arrow icon in HTTP labels and render their route as `host+path` (so the destination service is visible); `Server` spans render path-only. The [service map](#service-map) only draws an edge for `Client` / `Producer` spans — leaving a network call on `Internal` makes it invisible in the map.

## HTTP requests

The most heavily instrumented namespace. Maple extracts three fields into fast materialized-view columns at write time, then renders method, route, and status code in trace rows.

### Fast columns

Filtering on these is a scan over a small column instead of a per-row map lookup. Both the legacy and post-1.21 OTel semconv names map to the same column — the first non-empty source wins, so you don't need to migrate just for fast filtering.

| Attribute(s)                                    | MV column        |
| ----------------------------------------------- | ---------------- |
| `http.method`, `http.request.method`            | `HttpMethod`     |
| `http.route`, `url.path`, `http.target`         | `HttpRoute`      |
| `http.status_code`, `http.response.status_code` | `HttpStatusCode` |

### Method color pills

`http.method` / `http.request.method` drives a colored pill on the span row. Colors from `HTTP_METHOD_COLORS` in [http.ts:131-139](../packages/ui/src/lib/http.ts):

| Method  | Color                |
| ------- | -------------------- |
| GET     | Blue                 |
| POST    | Orange               |
| PUT     | Green                |
| PATCH   | Gray                 |
| DELETE  | Red                  |
| HEAD    | Gray                 |
| OPTIONS | Dark gray            |

### Status badge tiers

`http.status_code` / `http.response.status_code` is rendered as a colored badge in the trace list ([traces-table.tsx:57-74](../apps/web/src/components/traces/traces-table.tsx)):

| Status range | Tone                |
| ------------ | ------------------- |
| 5xx          | Error (red)         |
| 4xx          | Warn (amber)        |
| 3xx          | Info (chart purple) |
| 1xx–2xx      | Info (blue)         |

In log chips, the same value is also scored 95 (top of the chip strip, just below `exception.*`) — see [Attribute prominence](#appendix-attribute-prominence-scoring).

### Route extraction & fallback chain

For full HTTP info ([http.ts:61-129](../packages/ui/src/lib/http.ts)), Maple tries each source in order until one matches:

**Method:** `http.method` → `http.request.method` → span name (e.g. `http.server GET /path`, or bare `GET /path`).

**Route on server spans:** `http.route` → `http.target` → `url.path`.

**Route on client spans:** `http.route` → parsed `url.full` / `http.url` (host+path) → `server.address` / `net.peer.name` combined with `url.path` / `http.target`.

**Status:** `http.status_code` → `http.response.status_code`.

So `url.full` (e.g. `https://api.tinybird.co/v0/sql`) on a `Client` span lights up route rendering automatically — but emitting `http.route` is preferred because it's a semantic path (`/api/users/:id`) instead of a high-cardinality URL.

## Service map

The map renders nodes for services and edges for the calls between them. Three rules to make sure your spans show up correctly.

### 1. Service-to-service edges

Emit `peer.service` on every `Client` or `Producer` span. The [`service_map_edges_hourly_mv`](../packages/domain/src/tinybird/materializations.ts) materialized view groups on `(SourceService, TargetService, DeploymentEnv)` per hour where `peer.service` is non-empty.

```
GET /v1/users  (service.name=api, span.kind=Client, peer.service=users-service)
                            └──> draws an edge api → users-service
```

If you put `peer.service` on a `Server` span, or leave it off entirely, no edge is drawn — the call won't appear in the map.

### 2. Database nodes

Pair `db.system` with `peer.service` on the same `Client` span — both are required. The map aggregates by `db.system`, so multiple services calling the same database land on a single shared node ([service-map-utils.ts:184-203](../apps/web/src/components/service-map/service-map-utils.ts)).

```
SELECT * FROM users  (span.kind=Client, db.system=postgresql, peer.service=postgresql)
                            └──> draws an edge api → postgresql DB node
```

### 3. Pick canonical names

Keep `peer.service` spelling consistent across services so edges don't fragment. If one service emits `peer.service=tinybird` and another emits `peer.service=Tinybird` or `peer.service=tb`, they become separate nodes. Pick one canonical name per peer and stick with it.

## Database queries

In addition to powering the service map, these drive the chip strip and the AI error-debug prompt context.

| Attribute      | What Maple does with it                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `db.system`    | Scored 70 in the chip strip; pairs with `peer.service` for service map DB nodes; toned `info` in log chips.      |
| `db.statement` | Scored 70; rendered in span detail; included as context in the error-debug prompt.                               |
| `db.operation` | Scored 70 (e.g. `"SELECT"`, `"INSERT"`).                                                                         |

Source: [log-attributes.ts:37](../apps/web/src/lib/log-attributes.ts).

## Caching

Maple detects a cache span when **any** `cache.*` attribute is present. When detected, the trace UI renders a hit/miss badge and an operation pill (GET / SET / DELETE) on the span row.

| Attribute                | Example                | What Maple does with it                                                       |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `cache.system`           | `redis`, `memcached`   | Identifies the cache backend; presence triggers cache-span detection.         |
| `cache.result`           | `hit` \| `miss`        | Drives the hit/miss badge color; presence also triggers cache-span detection. |
| `cache.name`             | `user-sessions`        | Logical cache name shown in span detail.                                      |
| `cache.operation`        | `GET`, `SET`, `DELETE` | Drives the operation pill color.                                              |
| `cache.lookup_performed` | `true` \| `false`      | Whether a lookup was actually executed (string, not bool).                    |

Source: [cache.ts](../apps/web/src/lib/cache.ts).

## Errors & exceptions

Drives the destructive-tone error banner shown on log rows ([log-error-banner.tsx:12-22](../apps/web/src/components/logs/log-error-banner.tsx)) and the highest-priority chip on every row.

| Attribute           | What Maple does with it                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exception.message` | Banner body. Falls back to `error.message`, then to the log body.                                                                                |
| `exception.type`    | Banner top-right monospace badge. Falls back to `error.type`.                                                                                    |
| `error.message`     | Same as `exception.message` (legacy fallback).                                                                                                   |
| `error.type`        | Same as `exception.type` (legacy fallback). Also used by Maple-internal services to categorize failure reasons.                                  |

Any attribute matching `exception.*` is scored 100 (top of the chip strip) and auto-toned `error` (red) in log chips — see [log-attributes.ts:33,60](../apps/web/src/lib/log-attributes.ts).

If `exception.message` is longer than 120 characters or contains a newline, the banner collapses by default and shows a "Show full error" toggle.

## RPC

For gRPC and other RPC frameworks.

| Attribute             | What Maple does with it                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `rpc.service`         | Scored 68 in chip strip; toned `info`.                                                                               |
| `rpc.method`          | Scored 68; toned `info`.                                                                                             |
| `rpc.grpc.status_code`| Scored 90 (just below HTTP status). Non-zero values auto-toned `error` (red).                                        |

Source: [log-attributes.ts:35,38,77-83](../apps/web/src/lib/log-attributes.ts).

## User identity

Promotes user/customer context to the chip strip so it's visible at a glance on every log row.

| Attribute                                                  | What Maple does with it                              |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `user.id`, `enduser.id`, `customer.id`, `customer_id`      | All scored 66 in chip strip (equivalent priority).   |

Source: [log-attributes.ts:39](../apps/web/src/lib/log-attributes.ts).

## Log severity

For log records (not spans). Drives the per-row text color in the log list and the trace detail timeline.

| `log.severityText` value | Color theme    |
| ------------------------ | -------------- |
| `TRACE`                  | severity-trace |
| `DEBUG`                  | severity-debug |
| `INFO`                   | severity-info  |
| `WARN`                   | severity-warn  |
| `ERROR`                  | severity-error |
| `FATAL`                  | severity-fatal |

`ERROR` and `FATAL` severities additionally cause the error banner to render at the top of the log detail panel. Source: [span-detail-panel.tsx:57-64](../apps/web/src/components/traces/span-detail-panel.tsx).

## Kubernetes & infrastructure

Tag spans with `k8s.*` and they light up the service map's pod-count badges and Infrastructure tab. The `maple-k8s-infra` Helm chart sets most of these for you via the OTel operator + `k8sattributes` processor — see [service-map-infrastructure.md](service-map-infrastructure.md) for the full enrichment lifecycle.

### Workload identity (joins to `service.name`)

| Attribute              | What Maple does with it                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `k8s.deployment.name`  | Primary workload identity; joins to `service.name` to populate the Infrastructure tab. |
| `k8s.statefulset.name` | Same join, for stateful workloads.                                                     |
| `k8s.daemonset.name`   | Same join, for DaemonSets.                                                             |
| `k8s.job.name`         | Same join, for Jobs.                                                                   |

### Promoted to log chips

Always shown in the chip strip when present.

| Attribute              | What Maple does with it                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `k8s.pod.name`         | Promoted to log attribute chips.                                                       |
| `k8s.namespace.name`   | Promoted to log attribute chips.                                                       |
| `k8s.cluster.name`     | Cluster column on the Infrastructure tab.                                              |
| `cloud.region`         | Promoted to log attribute chips.                                                       |

### Node detail metadata

| Attribute              | What Maple does with it                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `k8s.node.name`        | Required to match node metrics from kubelet; node-list and node-detail views.          |
| `k8s.node.uid`         | Display in node metadata panel.                                                        |
| `k8s.pod.uid`          | Used to count distinct pods per workload.                                              |
| `k8s.kubelet.version`  | Display in node metadata panel.                                                        |
| `container.runtime`    | Display in K8s node metadata (containerd, cri-o, etc.).                                |

## Cloud & platform badges

These set the platform badge and runtime icon next to a service on the service map. SDKs running on common platforms auto-detect most of them — document the keys so self-instrumenters can match.

| Attribute              | Example values                                                | What Maple does with it                                |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `cloud.provider`       | `aws`, `gcp`, `azure`, `cloudflare`, `vercel`, `railway`      | Provider icon / badge resolution.                      |
| `cloud.platform`       | `aws_lambda`, `cloudflare.workers`, `gcp_cloud_run`           | More granular platform badge.                          |
| `cloud.region`         | `us-west-2`, `iad1`                                           | Promoted to log chips (see Kubernetes section above).  |
| `process.runtime.name` | `nodejs`, `bun`, `deno`, `workerd`, `rust`, `jvm`             | Runtime icon on the service map.                       |
| `faas.name`            | Lambda function name, Cloud Run service name                  | Function-name badge on FaaS deployments.               |
| `faas.version`         | Function version / revision                                   | Per-version slicing on FaaS.                           |
| `faas.instance`        | Function execution / instance ID                              | Replica identifier on FaaS.                            |

Keep `process.runtime.name` values consistent across services running the same runtime — don't have one service emit `nodejs` and another `node`, or you'll get two runtime icons for the same fleet.

## Sampling-aware throughput

Maple reads the W3C `tracestate: ot=th:<threshold>` header to extrapolate throughput counts when you're sampling traces. See [sampling-throughput.md](sampling-throughput.md) for the math and SDK setup. You don't emit anything as an attribute — this is a header on the trace context.

## Filter aliases

In Maple's WHERE-clause search bar (trace list, log search, dashboard widgets), you can type a short alias and it resolves to the canonical attribute. Source of truth: `normalizeKey` in [packages/domain/src/where-clause.ts](../packages/domain/src/where-clause.ts).

| Alias                | Resolves to                                        |
| -------------------- | -------------------------------------------------- |
| `service`            | `service.name`                                     |
| `span`               | `span.name`                                        |
| `environment`, `env` | `deployment.environment`                           |
| `commit_sha`         | `deployment.commit_sha`                            |
| `root.only`          | `root_only` (synthetic boolean — root spans only)  |
| `errors_only`        | `has_error` (synthetic boolean — error spans only) |

So `env = "production"` and `deployment.environment = "production"` mean the same thing; pick whichever is shorter.

## Reserved namespace

`maple_*` is reserved for Maple platform internals (org routing, ingest auth keys). Do not use this prefix for your own attributes — the UI hides anything starting with `maple_` from log and span attribute chips.

## Attributes Maple hides in the UI chip strip

These are stored on the row but skipped from the log/span attribute chip strip because they're noisy or already shown elsewhere (service column, etc.). Source: [apps/web/src/lib/log-attributes.ts](../apps/web/src/lib/log-attributes.ts).

- `service.name`, `service.namespace`, `service.instance.id`, `service.version`
- `telemetry.sdk.*`
- `process.runtime.*`, `process.executable.*`
- `os.*`
- `host.arch`, `host.name`
- `maple_*`

The data is still queryable — you can filter or group by these in the search bar — they're just not auto-promoted into the row's attribute chips.

## Appendix: Attribute prominence scoring

The chip strip on each log/span row shows the top 4 attributes by score. Higher score = more prominent. Source: `scoreKey` in [log-attributes.ts:32-49](../apps/web/src/lib/log-attributes.ts).

| Score | Attributes                                                                       |
| ----- | -------------------------------------------------------------------------------- |
| 100   | `error`, `exception`, `exception.*` (anything)                                   |
| 95    | `http.status_code`, `http.response.status_code`                                  |
| 90    | `rpc.grpc.status_code`                                                           |
| 80    | `http.method`, `http.request.method`                                             |
| 70    | `db.system`, `db.statement`, `db.operation`                                      |
| 68    | `rpc.service`, `rpc.method`                                                      |
| 66    | `user.id`, `enduser.id`, `customer.id`, `customer_id`                            |
| 60    | `duration_ms`, `latency_ms`, `http.duration`                                     |
| 55    | `http.url`, `http.route`, `url.path`                                             |
| 40    | Other `http.*`, `url.*`                                                          |
| 38    | Other `db.*`                                                                     |
| 36    | Other `rpc.*`                                                                    |
| 34    | `messaging.*`                                                                    |
| 32    | Other `user.*`, `enduser.*`                                                      |
| 25    | Anything with a dot (`namespace.key`)                                            |
| 20    | Bare keys (no namespace)                                                         |

Resource attributes only appear in chips if they're in the [`PROMOTED_RESOURCE_KEYS` set](../apps/web/src/lib/log-attributes.ts) (deployment env, k8s pod/namespace, cloud region); other resource attrs get their score decremented by 10 even if promoted.

## See also

- [sampling-throughput.md](sampling-throughput.md) — sampling-aware throughput math and `tracestate: ot=th:` reading.
- [service-map-infrastructure.md](service-map-infrastructure.md) — full lifecycle for `k8s.*` enrichment.
- [self-hosted-clickhouse.md](self-hosted-clickhouse.md) — schema and column layout for self-hosters.
