---
title: "Docker Infrastructure"
description: "Run the Maple Docker agent as a single container to stream per-container CPU, memory, network, block I/O, and logs — and correlate them with your app's traces."
group: "Infrastructure"
order: 2
---

Maple's Docker agent is a single OpenTelemetry Collector container with read-only access to the
Docker socket. Once it's running, **Infrastructure → Containers** lights up with every container on
the host, spans and logs that carry container identity gain an **Infrastructure** tab, and the
**Docker Containers** dashboard template fills in.

Running Kubernetes? Use the [Kubernetes Infrastructure guide](/docs/guides/kubernetes-infrastructure)
instead — the Helm chart covers pods, nodes, and workloads cluster-wide.

The agent collects:

- **Per-container metrics** via the `docker_stats` receiver — CPU, memory, network, block I/O,
  restarts, uptime, and PID counts, every 30 seconds
- **Container logs** via the mounted `json-file` log directory (optional — drop the mount to skip)
- **App OTLP** on ports 4317 (gRPC) and 4318 (HTTP), so it doubles as the host's local collector

All signals are exported over OTLP HTTP to Maple's ingest gateway.

## Prerequisites

- Docker Engine with the default `json-file` logging driver (for log collection)
- A **private ingest key** — copy it from **Settings → Ingestion** in the Maple UI
- Ports 4317 and 4318 free on the host. If you already run a collector there, drop the `-p` flags
  below and keep pointing your apps at the existing one — the agent still collects container
  metrics and logs without them.

## Install

Run the agent on each Docker host:

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

Containers appear under **Infrastructure → Containers** within about a minute.

Notes on the flags:

- `--user 0:0` is required: the Docker socket and `/var/lib/docker/containers` are not readable by
  the image's non-root user. The socket mount is read-only.
- The `/var/lib/docker/containers` mount only feeds **log** collection — drop it if you don't want
  container logs.
- The `maple-agent-state` volume persists log-read checkpoints across agent restarts.
- `-e MAPLE_ENVIRONMENT=staging` sets the deployment environment (defaults to `production`).
- Self-hosting Maple? Point the agent at your gateway with `-e MAPLE_ENDPOINT=https://ingest.your-domain`.

### Docker Compose

```yaml
services:
  maple-agent:
    image: ghcr.io/makisuo/maple/otel-collector-maple:0.2.0
    command: ["--config", "/etc/otel/docker-config.yaml"]
    restart: unless-stopped
    user: "0:0"
    environment:
      MAPLE_INGEST_KEY: YOUR_MAPLE_INGEST_KEY
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - maple-agent-state:/var/lib/otelcol
    ports:
      - "4317:4317"
      - "4318:4318"

volumes:
  maple-agent-state:
```

Compose projects get first-class facets: the agent maps the `com.docker.compose.project` and
`com.docker.compose.service` labels onto every container's metrics, so the Containers page can
filter by project and service.

## What gets collected

| Metric                                         | What it powers                                    |
| ---------------------------------------------- | ------------------------------------------------- |
| `container.cpu.utilization`                    | CPU column, saturation ranking, CPU chart         |
| `container.memory.percent`                     | Memory-vs-limit column and chart                  |
| `container.memory.usage.total` / `.limit`      | Memory bytes chart + limit metadata               |
| `container.network.io.usage.rx_bytes`/`tx_bytes` | Network I/O chart                               |
| `container.blockio.io_service_bytes_recursive` | Block I/O chart (by operation)                    |
| `container.restarts`, `container.uptime`       | Restart count and uptime on the detail page       |
| `container.cpu.limit`, `container.pids.count`  | Served on the container API; not charted yet      |

Identity rides on resource attributes: `container.name`, `container.id`, `container.image.name`,
`container.runtime`, and `host.name` (detected from the Docker daemon, so it reports the host —
not the agent container). Container names are only unique per host; Maple keys everything on
`(container.name, host.name)`.

CPU utilization is Docker's percentage — it can exceed 100% on multi-core containers, and most
plain-Docker containers run without limits, so treat the saturation ranking as "worst offenders
first", not as a strict capacity signal.

## Correlate app telemetry

Spans and logs open an **Infrastructure** tab when they carry container identity. Unlike
Kubernetes (where the OTel Operator injects it), plain Docker has no injection mechanism — your
app's SDK has to stamp it:

- **`@maple/effect-sdk`** detects Docker identity automatically (best-effort: it reads
  `/proc/self/mountinfo`, then `/proc/self/cgroup`, then falls back to the short-id hostname).
- Any other OTel SDK: set it explicitly in your compose file — Docker's default hostname **is**
  the short container id:

  ```yaml
  environment:
    OTEL_RESOURCE_ATTRIBUTES: "container.id=${HOSTNAME},container.name=myservice"
  ```

If your containers set a custom `hostname:`, the fallback can't fire — set
`OTEL_RESOURCE_ATTRIBUTES` explicitly.

## Security notes

- The agent needs the Docker socket read-only, but socket access is still effectively host-root —
  run the agent only on hosts you control, and prefer pinning the image tag over `latest`.
- The install command embeds your **private ingest key**. Rotate it from **Settings → Ingestion**
  if it leaks.

## Troubleshooting

- **Nothing after two minutes** — check the agent's own logs: `docker logs maple-agent`. A `401`
  from the exporter means the ingest key is wrong or was rotated.
- **`port is already allocated`** — another collector already owns 4317/4318 on this host. Drop the
  `-p` flags (see Prerequisites) or remap them.
- **`permission denied` on the socket** — the agent isn't running as root (`--user 0:0`), or the
  socket lives elsewhere (rootless Docker uses `$XDG_RUNTIME_DIR/docker.sock`; rootless setups
  aren't supported by the one-liner yet).
- **Metrics but no logs** — the log-directory mount is missing, or your daemon uses a logging
  driver other than `json-file`.
- **A container shows as "stale"** — the agent stopped scraping it for over five minutes; check
  whether the agent restarted or the host is overloaded.
