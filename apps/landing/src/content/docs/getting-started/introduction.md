---
title: "Introduction"
description: "Maple is an open-source observability platform for traces, logs, and metrics, built on OpenTelemetry."
group: "Getting Started"
order: 1
---

Maple is an open-source observability platform that gives you full visibility into your distributed systems. Explore traces, logs, and metrics in a single unified interface -- no vendor lock-in, no proprietary agents.

## Traces

Visualize requests as they flow through your services with a full flamegraph and span hierarchy view. Drill into individual spans to see attributes, events, and errors. Maple automatically detects service-to-service dependencies and renders them as an interactive service map.

## Logs

Search and filter logs across all your services. Logs are automatically correlated with traces -- click a log line to jump to the exact trace and span that produced it.

## Metrics

Track throughput, error rates, and latency across services with real-time charts. Maple automatically detects probability-based sampling and extrapolates accurate throughput numbers from sampled data.

## Service Map

See how your services connect at a glance. The service map shows call rates, error rates, and latency between services, making it easy to spot bottlenecks and failing dependencies.

## AI-Powered Queries

Ask questions about your system in natural language using Maple's MCP integration. Diagnose errors, find slow traces, and explore service health without writing queries.

## Getting Started

1. Sign up at [app.maple.dev](https://app.maple.dev) or self-host on your own infrastructure
2. Point your OpenTelemetry SDK at Maple's ingest endpoint
3. Start exploring in the dashboard

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_SERVICE_NAME="my-service"
```

Follow our language-specific guides:

- [Node.js Instrumentation](/docs/guides/instrumentation-nodejs) -- includes Next.js setup
- [Effect SDK](/docs/sdks/effect) -- official Maple SDK for Effect apps
- [Python Instrumentation](/docs/guides/instrumentation-python)
- [Go Instrumentation](/docs/guides/instrumentation-go)

For details on required attributes and data conventions, see [OpenTelemetry Conventions](/docs/concepts/otel-conventions).
