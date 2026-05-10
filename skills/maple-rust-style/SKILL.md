---
name: maple-rust-style
description: "Rust OpenTelemetry style for Maple: opentelemetry + opentelemetry_sdk + opentelemetry-otlp HTTP exporter, tracing-opentelemetry bridge for the tracing crate, inline endpoint + ingest key, semconv resource attributes."
---

# Maple Rust style

Use the official `opentelemetry` + `opentelemetry_sdk` crates with `opentelemetry-otlp` (HTTP exporter, not gRPC). Bridge the `tracing` crate via `tracing-opentelemetry` so existing `info!` / `error!` calls flow through OTLP.

## Cargo.toml

```toml
[dependencies]
opentelemetry = "0.27"
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"] }
opentelemetry-otlp = { version = "0.27", features = ["http-proto", "reqwest-client", "logs", "metrics"] }
opentelemetry-semantic-conventions = "0.27"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-opentelemetry = "0.28"
```

## Bootstrap

Inline the endpoint and ingest key — they're a project-scoped, write-only token (Sentry-DSN-shaped).

```rust
use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::{LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::{
    logs::LoggerProvider, metrics::SdkMeterProvider, trace::TracerProvider, Resource,
};
use opentelemetry_semantic_conventions::resource::{
    DEPLOYMENT_ENVIRONMENT_NAME, SERVICE_NAME,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAPLE_ENDPOINT: &str = "https://ingest.maple.dev";
const MAPLE_KEY: &str = "MAPLE_TEST"; // set by maple-onboard skill on pairing

pub fn init() -> Result<(TracerProvider, LoggerProvider, SdkMeterProvider), opentelemetry_otlp::ExporterBuildError> {
    let auth = format!("Bearer {MAPLE_KEY}");
    let mut headers = std::collections::HashMap::new();
    headers.insert("authorization".to_string(), auth);

    let resource = Resource::builder()
        .with_attributes([
            KeyValue::new(SERVICE_NAME, "orders-api"),
            KeyValue::new(DEPLOYMENT_ENVIRONMENT_NAME, std::env::var("DEPLOYMENT_ENV").unwrap_or_else(|_| "development".into())),
            KeyValue::new("vcs.repository.url.full", "https://github.com/acme/orders-api"),
            KeyValue::new("vcs.ref.head.revision", std::env::var("GITHUB_SHA").unwrap_or_default()),
        ])
        .build();

    let trace_exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/traces"))
        .with_headers(headers.clone())
        .with_protocol(Protocol::HttpJson)
        .build()?;
    let tracer_provider = TracerProvider::builder()
        .with_batch_exporter(trace_exporter)
        .with_resource(resource.clone())
        .build();
    global::set_tracer_provider(tracer_provider.clone());

    let log_exporter = LogExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/logs"))
        .with_headers(headers.clone())
        .with_protocol(Protocol::HttpJson)
        .build()?;
    let logger_provider = LoggerProvider::builder()
        .with_batch_exporter(log_exporter)
        .with_resource(resource.clone())
        .build();

    let metric_exporter = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{MAPLE_ENDPOINT}/v1/metrics"))
        .with_headers(headers)
        .with_protocol(Protocol::HttpJson)
        .build()?;
    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(metric_exporter)
        .with_resource(resource)
        .build();
    global::set_meter_provider(meter_provider.clone());

    let otel_layer = tracing_opentelemetry::layer().with_tracer(global::tracer("orders.api"));
    let otel_log_layer = opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(&logger_provider);

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(tracing_subscriber::fmt::layer())
        .with(otel_layer)
        .with(otel_log_layer)
        .init();

    Ok((tracer_provider, logger_provider, meter_provider))
}
```

Call from `main` and shut down on exit:

```rust
#[tokio::main]
async fn main() {
    let (tracer_provider, logger_provider, meter_provider) =
        telemetry::init().expect("telemetry init");

    // app run …

    let _ = tracer_provider.shutdown();
    let _ = logger_provider.shutdown();
    let _ = meter_provider.shutdown();
}
```

## Bounded business spans via `tracing`

The point of bridging `tracing` is so existing instrumentation works unchanged. Use `#[tracing::instrument]` on bounded async operations:

```rust
#[tracing::instrument(name = "order.submit", skip_all, fields(order.id = %order_id))]
async fn submit_order(order_id: &str) -> Result<(), Error> {
    charge_order(order_id).await?;
    Ok(())
}
```

`tracing::error!` and `?err` field interpolation will record the exception and set the span status to ERROR via the bridge.

## Coexistence

If the project already uses `tracing` with a Honeycomb / Datadog / Jaeger layer, leave it in place — add Maple's `tracing-opentelemetry` layer alongside. Don't strip the existing exporter unless the user asks.
