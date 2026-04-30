# Maple OTel Exporter

A custom OpenTelemetry Collector exporter that writes traces, logs, and
metrics directly into Maple's bespoke ClickHouse schema.

## Why this exists

The OpenTelemetry Collector Contrib distribution ships a `clickhouse` exporter
out of the box, but it writes a fixed schema (`otel_traces`, `otel_logs`,
`otel_metrics_*`) with column shapes that don't match Maple's tables. Maple's
UI/API queries `traces`, `logs`, `metrics_sum`, `metrics_gauge`,
`metrics_histogram`, `metrics_exponential_histogram` — and an extensive set of
materialized views fan inserts on those base tables out into derived
aggregate / detail / search-facet tables.

Rather than translate at runtime, this exporter emits Maple-shaped rows
directly via ClickHouse's HTTP `JSONEachRow` ingest. The MVs handle the rest
inside ClickHouse.

## Configuration

```yaml
exporters:
  maple:
    endpoint: https://ch.superwall.dev          # ClickHouse HTTP base URL
    database: default
    username: maple
    password: ${env:MAPLE_CLICKHOUSE_PASSWORD}
    org_id: org_3AuiNCIuD1XCbbzcjkzE3s5HoQj    # static fallback; per-record
                                                # `maple_org_id` resource attr
                                                # wins over this
    timeout: 30s
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 8
      queue_size: 10000
    # All optional — defaults match Maple migrations:
    # traces_table_name: traces
    # logs_table_name: logs
    # metrics_sum_table_name: metrics_sum
    # metrics_gauge_table_name: metrics_gauge
    # metrics_histogram_table_name: metrics_histogram
    # metrics_exponential_histogram_table_name: metrics_exponential_histogram
```

The exporter expects Maple's CH schema to already exist (run the migrations
in `packages/domain/src/clickhouse/migrations/`). It will not auto-create
tables.

## Org id resolution

**Default (single-tenant):** the exporter stamps `OrgId` from `org_id` in
the config on every record, unconditionally. No upstream processor required.

**Multi-tenant fan-out (opt-in):** if you set
`org_id_from_resource_attribute: maple_org_id` (or any other attribute name)
in the exporter config, the exporter reads the org id from that resource
attribute on each record. If the attribute is missing or empty for a given
record, the static `org_id` from config is used as a fallback.

```yaml
# Single-tenant deploy — typical case
exporters:
  maple:
    org_id: org_3AuiNCIuD1XCbbzcjkzE3s5HoQj
    # everything stamped with that org_id

# Multi-tenant fan-out
exporters:
  maple:
    org_id: org_default                              # fallback
    org_id_from_resource_attribute: maple_org_id     # per-record override
```

## Building

This exporter is consumed by the OpenTelemetry Collector Builder (`ocb`) — see
`deploy/k8s-infra/builder-config.yaml`. To produce a binary:

```bash
go install go.opentelemetry.io/collector/cmd/builder@latest
builder --config=deploy/k8s-infra/builder-config.yaml
```

Output is a fully-functional collector binary including the standard contrib
receivers / processors plus this exporter.

## What writes where

| OTLP signal | Maple base table                  | Materialized views fan-out into                                                                                                            |
|-------------|-----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| Traces      | `traces`                          | `error_events`, `error_spans`, `service_overview_spans`, `service_map_*`, `trace_list_mv`, `trace_detail_spans`, `traces_aggregates_hourly`, `service_usage`, attribute facets |
| Logs        | `logs`                            | `logs_aggregates_hourly`, `service_usage`, log attribute facets                                                                            |
| Metrics     | `metrics_sum` / `metrics_gauge` / `metrics_histogram` / `metrics_exponential_histogram` | `service_usage`, metric attribute facets                                                |

The exporter only ever writes to the **base** tables. ClickHouse handles the
fan-out via `MATERIALIZED VIEW … TO …` definitions in migration `0001_initial`.

## Schema source of truth

`packages/domain/src/generated/clickhouse-schema.ts` is the canonical column
list. If you change the migrations there, regenerate that file and update the
encoders in `internal/encoding.go` + the per-signal `exporter_*.go` files
to keep field names in lockstep.

## Limitations

- **Summary metrics** are silently dropped — Maple has no summary table.
- **Native ClickHouse protocol (port 9000)** isn't supported. HTTP only, so
  the exporter works through nginx Ingress / Cloudflare / any other L7 hop.
- **Exemplars** for histograms are flattened to parallel arrays (matching
  Maple's column layout). Exemplars without trace context get empty hex
  strings.
