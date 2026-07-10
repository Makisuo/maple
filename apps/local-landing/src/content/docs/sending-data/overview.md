---
title: "Sending data (OTLP)"
description: "Point any OpenTelemetry SDK or collector at the local OTLP/HTTP endpoint — no exporter changes, no auth."
group: "Sending Data"
order: 1
---

Maple Local speaks **OTLP/HTTP** — the protocol every OpenTelemetry SDK already exports. While `maple start` is running, the server accepts all three signals on one port:

```
POST http://127.0.0.1:4318/v1/traces
POST http://127.0.0.1:4318/v1/logs
POST http://127.0.0.1:4318/v1/metrics
```

Payloads can be protobuf or JSON, optionally gzip-encoded. No auth header is needed locally. For OTLP/JSON, trace and span IDs follow the OTLP/JSON convention (hex strings).

## The universal setup

Every OpenTelemetry SDK honors the standard environment variables, so in most apps you don't change code at all:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_SERVICE_NAME="my-service"
```

Two things to check:

- **Protocol.** `:4318` is the OTLP/**HTTP** port convention, and Maple Local only speaks HTTP. If your SDK defaults to gRPC (some do), set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
- **Service name.** Set `OTEL_SERVICE_NAME` (or a `service.name` resource attribute) — it's how the dashboard and CLI group everything.

Then verify data is flowing:

```bash
maple services            # your service should appear here
maple traces --since 5m
```

## Language guides

Step-by-step SDK setup with working snippets:

- [Node.js](/docs/sending-data/nodejs)
- [Python](/docs/sending-data/python)
- [Go](/docs/sending-data/go)

Any other language with an OpenTelemetry SDK (Java, .NET, Rust, Ruby, PHP, …) works the same way — configure the OTLP/HTTP exporter with the endpoint above.

## From an OpenTelemetry Collector

Already running a collector? Add an `otlphttp` exporter and keep your existing pipelines:

```yaml
exporters:
    otlphttp:
        endpoint: http://127.0.0.1:4318

service:
    pipelines:
        traces:
            exporters: [otlphttp]
        logs:
            exporters: [otlphttp]
        metrics:
            exporters: [otlphttp]
```

## From docker containers

Inside a container, `127.0.0.1` is the container itself. Point the exporter at the host instead:

```bash
# docker run
-e OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
```

On Linux, add `--add-host=host.docker.internal:host-gateway` (or use the docker bridge IP).
