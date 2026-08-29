# Maple Docker Agent

A single-container OpenTelemetry Collector for plain Docker hosts — the non-Kubernetes sibling of
[`deploy/k8s-infra`](../k8s-infra/README.md). It ships in the same image
(`ghcr.io/makisuo/maple/otel-collector-maple`); this directory holds the ready-to-run config that
gets baked into that image at `/etc/otel/docker-config.yaml`, selected via
`--config /etc/otel/docker-config.yaml`.

What it collects:

- **Per-container metrics** via the `docker_stats` receiver (CPU, memory, network, block I/O,
  restarts, uptime, PIDs) every 30 seconds, over a read-only mount of the Docker socket
- **Container logs** via `filelog` over the `json-file` driver directory (optional mount)
- **App OTLP** on 4317 (gRPC) / 4318 (HTTP), so it doubles as the host's local collector

All signals export over OTLP HTTP to Maple's ingest gateway, which owns ingest-key auth and org
enrichment — same contract as the k8s chart. The end-user install guide (one-liner + compose
variant, what lights up in the product) lives at
[`apps/landing/src/content/docs/guides/docker-infrastructure.md`](../../apps/landing/src/content/docs/guides/docker-infrastructure.md);
the engineering end-to-end (attributes → queries → UI, and the design decisions) at
[`docs/docker-container-monitoring.md`](../../docs/docker-container-monitoring.md).

## Run

```bash
docker run -d --name maple-agent \
  --restart unless-stopped --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \
  -v maple-agent-state:/var/lib/otelcol \
  -p 4317:4317 -p 4318:4318 \
  -e MAPLE_INGEST_KEY=YOUR_MAPLE_INGEST_KEY \
  ghcr.io/makisuo/maple/otel-collector-maple:0.2.0 \
  --config /etc/otel/docker-config.yaml
```

Env contract:

| Variable            | Required | Meaning                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `MAPLE_INGEST_KEY`  | yes      | Org's private ingest key (`x-maple-ingest-key` header)         |
| `MAPLE_ENDPOINT`    | no       | Ingest gateway override for self-hosted (default hosted)       |
| `MAPLE_ENVIRONMENT` | no       | `deployment.environment(.name)` for unlabeled data (`production`) |

Notes that are easy to get wrong:

- `--user 0:0` is required: the runtime image is distroless **nonroot**, and neither the Docker
  socket nor `/var/lib/docker/containers` is readable by that user.
- The log-directory mount only feeds log collection — drop it to skip container logs. The
  `maple-agent-state` volume persists filelog checkpoints across restarts.
- The environment stamp uses `insert`, not `upsert`: app OTLP passing through the agent keeps its
  own `deployment.environment.*`; only unlabeled data (docker_stats, filelog) gets the agent's.
- Compose labels (`com.docker.compose.project`/`service`) are mapped to the `compose.project` /
  `compose.service` resource attributes — the Docker analog of the k8s namespace/workload facets.

## Config and image lifecycle

- [`collector-config.yaml`](./collector-config.yaml) is baked into the image by
  [`deploy/k8s-infra/Dockerfile.otel-collector-maple`](../k8s-infra/Dockerfile.otel-collector-maple);
  editing it requires a new image release to take effect for users of the one-liner.
- The image is built from [`deploy/k8s-infra/builder-config.yaml`](../k8s-infra/builder-config.yaml)
  (OpenTelemetry Collector Builder manifest — `dockerstatsreceiver` joined in 0.2.0) and published
  by `.github/workflows/publish-otel-collector-maple.yml` on `otel-collector-maple-v*` tags.
- Every user-facing reference to the tag (this README, the install modal in `apps/web`, the docs
  guide) must point at a tag that is already on GHCR — push the release tag before shipping copy
  that names it. The BYO-ClickHouse `renderCollectorYaml()` stays on the latest published tag for
  the same reason.

Not supported yet: rootless Docker (socket lives at `$XDG_RUNTIME_DIR/docker.sock`), podman, and
non-`json-file` logging drivers (metrics still work; logs need the json-file directory).
