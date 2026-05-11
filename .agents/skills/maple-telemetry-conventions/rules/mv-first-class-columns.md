# Tinybird MV pre-extracted columns

Some span and resource attributes get **extracted into typed columns** at write time by Tinybird materialized views. These columns are first-class: they're indexed, can be used in `WHERE` / `GROUP BY` without a Map lookup, and drive dashboard widgets directly. Everything else stays in the `SpanAttributes` / `ResourceAttributes` Map columns.

This file is the inventory — when you write a query that filters on one of these keys, prefer the column name. When you add a new MV column, follow the source-attribute consistency rule at the bottom.

Source: `packages/domain/src/tinybird/materializations.ts`

---

## `service_map_spans_mv`

Lightweight projection of trace spans for the service dependency map.

| Column | Extracted from | Line |
|---|---|---|
| `PeerService` | `SpanAttributes['peer.service']` | `materializations.ts:246` |
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:247` |

## `service_map_children_mv`

Spans with a parent, for child-of-edge analysis in the service map.

| Column | Extracted from | Line |
|---|---|---|
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:315` |

## `service_map_edges_hourly_mv`

Pre-aggregated client-to-peer edges. Pre-filters to spans with `peer.service != ''`.

| Column | Extracted from | Line |
|---|---|---|
| `TargetService` | `SpanAttributes['peer.service']` | `materializations.ts:341` |
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:342` |

## `service_overview_spans_mv`

Hourly service-overview rollup.

| Column | Extracted from | Line |
|---|---|---|
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:277` |
| `CommitSha` | `ResourceAttributes['deployment.commit_sha']` | `materializations.ts:278` (see file for the field) |

## `service_platforms_hourly_mv`

Per-service hosting-platform attributes for the service map's runtime-icon resolver. Pre-aggregates as `max()` of each attribute.

| Column | Extracted from | Line |
|---|---|---|
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:414` |
| `K8sCluster` | `max(ResourceAttributes['k8s.cluster.name'])` | `materializations.ts:415` |
| `K8sPodName` | `max(ResourceAttributes['k8s.pod.name'])` | `materializations.ts:416` |
| `K8sDeploymentName` | `max(ResourceAttributes['k8s.deployment.name'])` | `materializations.ts:417` |
| `CloudPlatform` | `max(ResourceAttributes['cloud.platform'])` | `materializations.ts:418` |
| `CloudProvider` | `max(ResourceAttributes['cloud.provider'])` | `materializations.ts:419` |

Additionally extracts (see file): `faas.name`, `sdk.type`, `process.runtime.name`.

## `error_spans_mv`

Materializes spans with `StatusCode = 'Error'`.

| Column | Extracted from | Line |
|---|---|---|
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:454` |

## `error_events_mv`

Unwraps the first OTel `exception` event from `EventsName` / `EventsAttributes` Maps.

| Column | Extracted from | Line |
|---|---|---|
| `ExceptionType` | first `exception` event's `exception.type` (fallback `StatusMessage`) | `materializations.ts:496-498` |
| `ExceptionMessage` | first `exception` event's `exception.message` | `materializations.ts:498` |
| `ExceptionStacktrace` | first `exception` event's `exception.stacktrace` | `materializations.ts:499` |
| `TopFrame` | (computed from stacktrace) | `materializations.ts` |
| `FingerprintHash` | cityHash64 of grouping keys | `materializations.ts:489` |
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:525` |

## `trace_list_mv`

Trace list optimized for the trace search UI. Pre-filters to entry-point spans.

| Column | Extracted from | Line |
|---|---|---|
| `HttpMethod` | `SpanAttributes['http.method']` (fallback `http.request.method`) | `materializations.ts:596` |
| `HttpRoute` | `SpanAttributes['http.route']` (fallbacks `url.path`, `http.target`) | `materializations.ts:597` |
| `HttpStatusCode` | `SpanAttributes['http.status_code']` (fallback `http.response.status_code`) | `materializations.ts:598` |
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:599` |

## `traces_aggregates_hourly_mv`

Hourly trace-shape rollup.

| Column | Extracted from | Line |
|---|---|---|
| `DeploymentEnv` | `ResourceAttributes['deployment.environment']` | `materializations.ts:778` |

Plus dimension keys pre-aggregated on the trace itself: `ServiceName`, `SpanName`, `SpanKind`, `StatusCode`, `IsEntryPoint`.

## `logs_aggregates_hourly_mv` (referenced)

Same pattern — extracts `DeploymentEnv` from `ResourceAttributes['deployment.environment']`. See `materializations.ts:809`.

---

## Cardinal rule — consistent source spellings

**If you add a new pre-extracted MV column, also emit the source attribute with that exact spelling.** Don't introduce a parallel spelling that the MV won't match.

Example: if you add a new MV column `HttpUserAgent` that extracts `SpanAttributes['http.user_agent']`, every service emitting spans **must** use `http.user_agent` as the attribute key. Don't have one service emit `http.user_agent` and another `userAgent` — only one will populate the column.

Corollary: **the dual-emit rule for `deployment.environment` is here**. Every MV in this file extracts `ResourceAttributes['deployment.environment']` (the legacy key). Until those MVs migrate to `coalesce(deployment.environment.name, deployment.environment)`, the legacy resource attribute **must** be emitted alongside the new one. See `rules/resource-attributes.md`.

## When NOT to extract into a column

- **Low cardinality keys you'll never group by** — just leave them in the Map.
- **Per-request user data that changes per span** — leave it in `SpanAttributes`. The Map column is queryable; extraction is for fields the dashboard hits on every request.
- **Anything still being designed** — pre-extraction is a one-way door once you've backfilled. Wait until the attribute name is stable.
