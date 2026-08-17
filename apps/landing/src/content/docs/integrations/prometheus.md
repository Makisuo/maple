---
title: "Prometheus Scraping"
description: "Pull metrics from any Prometheus-compatible endpoint with Maple's managed scrape agent — no collector to run, credentials stored server-side, scrape health built in."
group: "Integrations"
order: 0
---

Maple includes a managed Prometheus scrape agent: point it at any endpoint that serves the Prometheus exposition format and Maple polls it on your schedule, converts the samples to OpenTelemetry metrics, and ingests them like any other OTLP traffic. There is nothing to deploy on your side — no Prometheus server, no collector, no `remote_write` pipeline.

Scraped metrics land in the metrics explorer and dashboards under the service name you choose, are billed and routed exactly like your own OTLP traffic, and carry an `up`-style check history so you can see scrape health per target.

## Adding a scrape target

Open **Integrations → Prometheus** in the Maple dashboard and click **Add Target**.

| Field               | Notes                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**          | `Prometheus endpoint` for a plain exposition URL, or a managed integration like [PlanetScale](/docs/integrations/planetscale).                                                                                   |
| **Name**            | Display name; also the default service name.                                                                                                                                                                     |
| **Service Name**    | Optional. Metrics appear under this service in the explorer and service views.                                                                                                                                   |
| **URL**             | The full endpoint URL, e.g. `https://myapp.com:9090/metrics`. Must be reachable from Maple — loopback, private-range, and cloud-metadata addresses are rejected.                                                 |
| **Scrape Interval** | 5–300 seconds (default 15).                                                                                                                                                                                      |
| **Authentication**  | `None`, `Bearer Token` (`Authorization: Bearer …`), or `Basic Auth` (username + password). Credentials are encrypted at rest and never leave Maple's API — the scrape agent fetches through a server-side proxy. |

Targets can also be managed programmatically via the REST API at `/v2/scrape_targets` (create, update, delete, probe, and check history endpoints) using the same fields.

## Testing and health

- **Test** runs an immediate probe against the endpoint and reports success or the exact failure (HTTP status, timeout, TLS error).
- Every scheduled scrape is recorded: the target's detail panel shows an `up`/`down` check history with duration and sample counts, mirroring Prometheus's own scrape metadata.
- A failed scrape never advances the "last successful scrape" timestamp, so data gaps stay visible next to the error message.

## How the data looks

- Counters, gauges, histograms, and summaries are converted to their OTLP equivalents; metric names are preserved as-is.
- Each series carries `job` (the target name) and `instance` (the scraped host) plus any **labels** you configure on the target (a JSON object of extra attributes — useful for `cluster`, `env`, or team tags). The keys `job`, `instance`, and `maple_*`/`__*` prefixes are reserved.
- Metrics are queryable in dashboards, alerts, and the metrics explorer like any OTLP metric.

## Network reachability

The scrape happens from Maple's infrastructure, so the endpoint must be reachable from the internet (or via the hosted/control-plane metrics endpoint many vendors provide). For exporters that only listen inside a private network, either expose them through an authenticated gateway or run an OpenTelemetry Collector inside the network with a `prometheus` receiver and an OTLP exporter pointed at Maple's ingest endpoint.

## Ready-made integrations

- [WarpStream](/docs/integrations/warpstream) — scrape agent metrics directly or use WarpStream's hosted Prometheus endpoint.
- [PlanetScale](/docs/integrations/planetscale) — a first-class source type: Maple discovers every database branch's metrics endpoint automatically via PlanetScale's service-discovery API.
