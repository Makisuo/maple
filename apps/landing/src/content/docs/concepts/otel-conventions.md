---
title: "OpenTelemetry Conventions"
description: "Maple's expected OpenTelemetry attributes, status codes, span kinds, and data model conventions."
group: "Concepts"
order: 2
---

Maple is fully compatible with the OpenTelemetry Protocol (OTLP). This document describes the conventions and attributes that Maple uses to power its dashboards, service maps, and analytics.

## Ingest Endpoints

Send telemetry to Maple using standard OTLP HTTP endpoints:

| Signal  | Endpoint      |
| ------- | ------------- |
| Traces  | `/v1/traces`  |
| Logs    | `/v1/logs`    |
| Metrics | `/v1/metrics` |

**Base URL:** `https://ingest.maple.dev`

**Content types:**

- `application/x-protobuf` (recommended)
- `application/json`

**Compression:** gzip supported via `Content-Encoding: gzip` header.

## Authentication

Include your API key in the request headers:

```
Authorization: Bearer YOUR_API_KEY
```

Alternatively, use the `x-maple-ingest-key` header:

```
x-maple-ingest-key: YOUR_API_KEY
```

API keys are available in your Maple project settings.

## Resource Attributes

### Required

| Attribute      | Description                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `service.name` | Identifies the service. Used for grouping in the services list and service map. |

### Recommended

| Attribute                | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `deployment.environment` | Environment name (`production`, `staging`, `development`). Used for filtering and release tracking. |
| `deployment.commit_sha`  | Git commit SHA. Enables release markers on charts and deployment tracking.                          |
| `service.version`        | Service version string.                                                                             |

Set resource attributes via environment variable:

```bash
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,deployment.commit_sha=abc123"
```

## Span Status Codes

Maple stores span status codes as title-case strings:

| Value     | Meaning                           |
| --------- | --------------------------------- |
| `"Unset"` | Default -- no explicit status set |
| `"Ok"`    | Explicitly marked successful      |
| `"Error"` | Span encountered an error         |

The OpenTelemetry Collector normalizes integer status codes (0, 1, 2) to these strings automatically. Only spans with `StatusCode = 'Error'` appear in error analytics.

## Span Kinds

| Kind         | Description                          | How Maple Uses It                       |
| ------------ | ------------------------------------ | --------------------------------------- |
| `"Server"`   | Incoming request handler             | Throughput and error rate calculations  |
| `"Client"`   | Outgoing request to another service  | Service map edges (with `peer.service`) |
| `"Producer"` | Async message producer               | Service map edges (with `peer.service`) |
| `"Consumer"` | Async message consumer               | Throughput calculations                 |
| `"Internal"` | Default, synchronous in-process work | Trace detail view                       |

## Service Map

For service-to-service dependencies to appear on the service map, set the `peer.service` attribute on **Client** and **Producer** spans:

```
peer.service = "downstream-service-name"
```

The value must match the `service.name` of the downstream service. For example, when service A calls service B's API:

```javascript
span.setAttribute("peer.service", "service-b")
```

Maple materializes these attributes into a dedicated service edges table for fast dependency queries.

## HTTP Attributes

Auto-instrumentation libraries typically set these automatically. Maple uses them for trace filtering and breakdown views:

| Attribute                                        | Description             | Example        |
| ------------------------------------------------ | ----------------------- | -------------- |
| `http.method` / `http.request.method`            | HTTP verb               | `"GET"`        |
| `http.route`                                     | Route template          | `"/users/:id"` |
| `http.status_code` / `http.response.status_code` | Response code           | `200`          |
| `http.target` / `url.path`                       | Request path (fallback) | `"/users/42"`  |

## Logs

### Severity Levels

| SeverityText | SeverityNumber |
| ------------ | -------------- |
| `TRACE`      | 1-4            |
| `DEBUG`      | 5-8            |
| `INFO`       | 9-12           |
| `WARN`       | 13-16          |
| `ERROR`      | 17-20          |
| `FATAL`      | 21-24          |

### Trace Correlation

Logs are automatically correlated with traces when `TraceId` and `SpanId` fields are present. Most OTel SDKs inject these fields when a span is active.

## Metrics

Maple accepts OTLP metrics at `/v1/metrics`, including counters, gauges, histograms, and summaries.

For accurate RED (Rate, Error, Duration) metrics alongside sampled traces, use the OpenTelemetry Collector [SpanMetrics Connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetrics):

```yaml
connectors:
    spanmetrics:
        namespace: span.metrics

service:
    pipelines:
        traces:
            receivers: [otlp]
            exporters: [otlp/maple, spanmetrics]
        metrics:
            receivers: [spanmetrics]
            exporters: [otlp/maple]
```

This derives 100%-accurate metrics from every span before sampling reduces the trace volume. See [Sampling & Throughput Estimation](/docs/concepts/sampling-throughput) for details.

## Data Retention

| Signal          | Retention |
| --------------- | --------- |
| Traces and logs | 90 days   |
| Metrics         | 365 days  |

## Environment Variable Reference

Configure any OTel SDK using standard environment variables instead of (or in addition to) programmatic setup:

```bash
# Required
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_SERVICE_NAME="my-service"

# Recommended
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,deployment.commit_sha=abc123"
```

These variables are supported by all official OpenTelemetry SDKs.
