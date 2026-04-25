# Attributes Maple recognizes

Maple stores every OTel attribute you send verbatim, but a small set get special treatment — extracted into fast columns at ingest, exposed as short filter aliases in the search bar, or rendered in dedicated UI. This page lists them so you can instrument your apps to get the most out of Maple.

## Deployment & version tracking

Tag every span with these and you get per-environment and per-version slices for free across the services table, service map, and per-service overview.

| Attribute | Example | What Maple does with it |
| --- | --- | --- |
| `deployment.environment` | `production` | Filterable everywhere; per-env throughput / latency / error rate; environment chips in span detail. |
| `deployment.environment.name` | `production` | Accepted as an alias for `deployment.environment` in infrastructure queries. |
| `deployment.commit_sha` | `c0b92f68` | Per-version metrics in service overview; exposed as the `commit_sha` discovery facet so you can pivot by deploy. |

In the search bar, `env`, `environment`, and `commit_sha` are short aliases for these — see [Filter aliases](#filter-aliases) below.

## Caching

Maple detects a cache span when **any** `cache.*` attribute is present. When detected, the trace UI renders a hit/miss badge and an operation pill (GET / SET / DELETE) on the span row.

| Attribute | Example | What Maple does with it |
| --- | --- | --- |
| `cache.system` | `redis`, `memcached` | Identifies the cache backend; presence triggers cache-span detection. |
| `cache.result` | `hit` \| `miss` | Drives the hit/miss badge color; presence also triggers cache-span detection. |
| `cache.name` | `user-sessions` | Logical cache name shown in span detail. |
| `cache.operation` | `GET`, `SET`, `DELETE` | Drives the operation pill color. |
| `cache.lookup_performed` | `true` \| `false` | Whether a lookup was actually executed (string, not bool). |

These follow the OTel semantic conventions — if your SDK emits standard cache attributes you don't need to do anything extra.

## Kubernetes & infrastructure

Tag spans with `k8s.*` and they light up the service map's pod-count badges and Infrastructure tab. The `maple-k8s-infra` Helm chart sets most of these for you via the OTel operator + `k8sattributes` processor — see [service-map-infrastructure.md](service-map-infrastructure.md) for the full enrichment lifecycle.

| Attribute | What Maple does with it |
| --- | --- |
| `k8s.deployment.name` | Joins to `service.name` to populate the Infrastructure tab; primary workload identity. |
| `k8s.statefulset.name` | Same join, for stateful workloads. |
| `k8s.daemonset.name` | Same join, for DaemonSets. |
| `k8s.job.name` | Same join, for Jobs. |
| `k8s.pod.name` | Promoted to log attribute chips (always shown if present). |
| `k8s.namespace.name` | Promoted to log attribute chips. |
| `k8s.cluster.name` | Cluster column on the Infrastructure tab. |
| `cloud.region` | Promoted to log attribute chips. |

## HTTP (extracted to fast columns)

These attributes are pre-extracted at ingest into materialized-view columns, so filtering by them on the trace list is a scan over a small column instead of a per-row map lookup.

| Attribute | MV column |
| --- | --- |
| `http.method`, `http.request.method` | `HttpMethod` |
| `http.route`, `url.path`, `http.target` | `HttpRoute` |
| `http.status_code`, `http.response.status_code` | `HttpStatusCode` |

Both the legacy and post-1.21 OTel semconv names map to the same column, so you don't need to migrate your instrumentation just to get fast filtering. The first non-empty source wins.

## Filter aliases

In Maple's WHERE-clause search bar (trace list, log search, dashboard widgets), you can type a short alias and it resolves to the canonical attribute. Source of truth: `normalizeKey` in [packages/domain/src/where-clause.ts](../packages/domain/src/where-clause.ts).

| Alias | Resolves to |
| --- | --- |
| `service` | `service.name` |
| `span` | `span.name` |
| `environment`, `env` | `deployment.environment` |
| `commit_sha` | `deployment.commit_sha` |
| `root.only` | `root_only` (synthetic boolean — root spans only) |
| `errors_only` | `has_error` (synthetic boolean — error spans only) |

So `env = "production"` and `deployment.environment = "production"` mean the same thing; pick whichever is shorter.

## Reserved namespace

`maple_*` is reserved for Maple platform internals (org routing, ingest auth keys). Do not use this prefix for your own attributes — the UI hides anything starting with `maple_` from log and span attribute chips.

## Attributes Maple hides in the UI

These are stored on the row but skipped from the log/span attribute chip strip because they're noisy or already shown elsewhere (service column, etc.). Source: [apps/web/src/lib/log-attributes.ts](../apps/web/src/lib/log-attributes.ts).

- `service.name`, `service.namespace`, `service.instance.id`, `service.version`
- `telemetry.sdk.*`
- `process.runtime.*`, `process.executable.*`
- `os.*`
- `host.arch`, `host.name`
- `maple_*`

The data is still queryable — you can filter or group by these in the search bar — they're just not auto-promoted into the row's attribute chips.

## See also

- [sampling-throughput.md](sampling-throughput.md) — Maple also reads the `tracestate: ot=th:` value to extrapolate throughput under sampling.
- [service-map-infrastructure.md](service-map-infrastructure.md) — full lifecycle for `k8s.*` enrichment.
