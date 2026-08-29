# Docker container monitoring

How a plain-Docker host's containers become rows on `/infra/containers`, charts on the detail
page, and an Infrastructure tab on spans/logs — and the design decisions that will bite if
re-derived differently. The k8s sibling of this lifecycle is
[service-map-infrastructure.md](service-map-infrastructure.md); the end-user install guide is
`apps/landing/src/content/docs/guides/docker-infrastructure.md`.

## End-to-end flow

1. **Emit.** The Maple Docker agent (one container per host — see
   [`deploy/docker-agent/README.md`](../deploy/docker-agent/README.md)) runs the contrib
   `docker_stats` receiver against the host's Docker socket. Identity rides on
   ResourceAttributes: `container.name`, `container.id` (64-hex), `container.image.name`,
   `container.runtime="docker"`, plus `host.name` from the `resourcedetection` **docker**
   detector (the receiver itself never emits it, and the system detector alone would report the
   agent container's own hostname). Compose labels map to `compose.project`/`compose.service`.
   Container logs come from `filelog` over the json-file directory and carry only `container.id`
   (parsed from the file path).
2. **Ship & store.** OTLP HTTP → ingest gateway → warehouse, untouched: no gateway changes, no
   warehouse schema changes. Gauge-typed metrics land in `metrics_gauge`, sum-typed in
   `metrics_sum`, identity in the raw `ResourceAttributes` map — read at query time exactly like
   the pod queries.
3. **Query.** `packages/query-engine/src/ch/queries/containers.ts` mirrors the pod slice:
   list/summary/detail/counters/timeseries/facets, fixtured in the SQL catalog gate.
4. **Serve.** Five container endpoints under `/internal/query-engine` — `list-containers`,
   `containers-summary`, `container-detail-summary`, `container-infra-timeseries`,
   `container-facets` (`apps/api/src/routes/internal/query-engine.http.ts`), contracts in
   `packages/domain/src/http/query-engine.ts`.
5. **Render.** `/infra/containers` list + `/infra/containers/$containerName?host=` detail,
   the `container.name`-keyed correlation group on span/log Infrastructure tabs, and the
   `docker-containers` dashboard template.

## Load-bearing decisions

- **Identity is `(container.name, host.name)`.** Docker names are unique per host only — `redis`
  on five hosts is five rows. `container.id` is the `uniq()` facet-cardinality and correlation
  key (a recreated container keeps its name, not its id) and is displayed, never in the URL.
- **Percent scale is normalized in the queries.** docker_stats percents are 0..100; every
  projected percentage (list, summary, detail, and the cpu/memory_percent timeseries via
  `divideBy: 100`) divides by 100 so the 0.9/0.6 saturation thresholds and severity toning match
  the pod pages. CPU can legitimately exceed 1.0 on multi-core containers — documented,
  unclamped. The dashboard template charts the raw 0..100 gauge and says so in the widget title.
- **kubeletstats rows are excluded everywhere.** k8s per-container metrics also carry
  `container.name` (on the 0..1 scale); every container query, the correlation detector, and the
  dashboard template's widgets require `k8s.pod.name = ''`.
- **Sum-family aggregation is per-metric.** Cumulative counters (network, block I/O) surface
  bucketed sums (relative shape, same caveat as the host network chart). Sampled sums —
  `container.memory.usage.total` — must AVERAGE a bucket's samples (`average: true`); summing
  inflates the chart by samples-per-bucket.
- **Counters detail groups per host before differencing.** `restartsDelta = maxIf − minIf` over
  two hosts' independent cumulative counters would fabricate a delta from their offset; the
  query differences per `host.name`, then sums.
- **Compose labels are promoted from datapoint to resource.** `container_labels_to_metric_labels`
  lands `compose.project`/`compose.service` as *datapoint* attributes, but every container query
  reads them from `ResourceAttributes` — so `transform/compose` in the agent config moves them.
  docker_stats emits one Resource per container, so a plain transform is safe here; the Fargate
  prometheus path in the k8s chart needs `groupbyattrs` first because one Resource covers many
  pods. The query tests assert SQL strings only, so they cannot catch a regression here — it
  shows up as permanently empty project/service facets.
- **Scopes are `saturated | elevated | stale` — deliberately no `unbounded`.** Running without
  limits is the norm in plain Docker, so the pod "burning CPU with nothing capping it" bucket
  doesn't transfer.

## Correlation (best-effort, and honestly labeled)

Docker has no k8sattributes/operator analog to inject identity into app telemetry:

- The reliable path is documented in the guide: `OTEL_RESOURCE_ATTRIBUTES` with `container.id`
  and `container.name` (Docker's default hostname *is* the short id).
- `@maple/effect-sdk` auto-detects `container.id`/`container.runtime` (mountinfo → cgroup →
  short-id hostname, via `process.getBuiltinModule` so edge bundles stay safe) — but not
  `container.name`, so auto-detection alone does not light the Infrastructure tab.
- Agent-shipped container logs carry only `container.id` — they correlate to Host, not to the
  container group.
- The correlation group is suppressed on k8s records and when a non-docker `container.runtime`
  is declared; records with `container.name` and no runtime attribute (e.g. some ECS setups)
  still render the group and its charts will be empty.

## Release coupling

The install one-liner, docs guide, and baked `/etc/otel/docker-config.yaml` all name
`otel-collector-maple:0.2.0`, published from the `otel-collector-maple-v0.2.0` tag (tag-driven
workflow — merging to main publishes nothing).

Two things bite here. The image name is derived from `github.repository_owner`, so since the move
to the MapleTechLabs org everything publishes to `ghcr.io/mapletechlabs/...`; the pre-move
`ghcr.io/makisuo/...` packages still exist, are still public, and are frozen at 0.1.5. And a GHCR
package created by a workflow starts **private** — visibility is per-package and has to be flipped
once by hand, so a freshly published image is not pullable by users until someone does.

Before announcing: confirm the package is public with an anonymous pull, then smoke one live agent
— `container.cpu.utilization` rows arriving through the hosted gateway, and the compose
project/service facets populating (the query tests assert SQL strings only, so they cannot prove
that path). The BYO-ClickHouse `renderCollectorYaml()` tracks the latest *published* tag.

## Not built yet, and why

`service_platforms_hourly` ContainerId/ContainerName columns + the `"docker"` service-map
platform badge (warehouse migration — read [warehouse-rollups.md](warehouse-rollups.md) first),
a container table on host detail, trimming the receiver's unused default-enabled metrics,
rootless Docker/podman socket paths, and the landing marketing page.
