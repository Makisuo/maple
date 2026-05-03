---
title: "Rust Instrumentation"
description: "Instrument a Rust application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Guides"
order: 7
sdk: "rust"
---

This guide covers instrumenting a Rust application to send traces and logs to Maple using the OpenTelemetry SDK and the `tracing` ecosystem.

## Prerequisites

- Rust 1.75+
- A Maple project with an API key

## Install Dependencies

Add the following to your `Cargo.toml`:

```toml
[dependencies]
opentelemetry = "0.27"
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"] }
opentelemetry-otlp = { version = "0.27", features = ["http-proto", "reqwest-client"] }
opentelemetry-semantic-conventions = "0.27"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-opentelemetry = "0.28"
tokio = { version = "1", features = ["full"] }
```

The `tracing` crate is the de-facto standard for instrumentation in Rust. The `tracing-opentelemetry` bridge forwards `tracing` spans and events to the OpenTelemetry SDK so they're exported to Maple.

## Configure the SDK

Initialize the tracer provider at application startup:

```rust
// src/telemetry.rs
use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{
    runtime, trace as sdktrace, Resource,
};
use opentelemetry_semantic_conventions::resource as semconv;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_tracing() -> Result<sdktrace::TracerProvider, Box<dyn std::error::Error>> {
    let resource = Resource::new(vec![
        KeyValue::new(semconv::SERVICE_NAME, "my-rust-app"),
        KeyValue::new(
            semconv::DEPLOYMENT_ENVIRONMENT,
            std::env::var("DEPLOYMENT_ENV").unwrap_or_else(|_| "development".into()),
        ),
    ]);

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint("https://ingest.maple.dev/v1/traces")
        .with_headers(
            [("Authorization".into(), "Bearer YOUR_API_KEY".into())]
                .into_iter()
                .collect(),
        )
        .build()?;

    let provider = sdktrace::TracerProvider::builder()
        .with_batch_exporter(exporter, runtime::Tokio)
        .with_resource(resource)
        .build();

    global::set_tracer_provider(provider.clone());

    let tracer = provider.tracer("my-rust-app");

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .init();

    Ok(provider)
}
```

Call it from `main`:

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let provider = telemetry::init_tracing()?;

    // Your application code here

    provider.shutdown()?;
    Ok(())
}
```

## Instrumentation Libraries

Rust does not have automatic library instrumentation -- you opt in per crate. The most common integrations:

### Axum / Tower HTTP

```toml
[dependencies]
tower-http = { version = "0.6", features = ["trace"] }
axum = "0.7"
```

```rust
use axum::{routing::get, Router};
use tower_http::trace::TraceLayer;

let app = Router::new()
    .route("/api/orders", get(handle_orders))
    .layer(TraceLayer::new_for_http());
```

### reqwest (HTTP client)

```toml
[dependencies]
reqwest-tracing = "0.5"
reqwest-middleware = "0.4"
```

```rust
use reqwest_middleware::ClientBuilder;
use reqwest_tracing::TracingMiddleware;

let client = ClientBuilder::new(reqwest::Client::new())
    .with(TracingMiddleware::default())
    .build();
```

## Custom Spans

The idiomatic way to create spans in Rust is the `#[instrument]` attribute:

```rust
use tracing::instrument;

#[instrument(skip(payment_client), fields(order.id = %order_id, peer.service = "payment-api"))]
async fn process_order(
    payment_client: &PaymentClient,
    order_id: String,
) -> Result<(), PaymentError> {
    payment_client.charge(&order_id).await?;
    Ok(())
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

For manual span creation:

```rust
use tracing::{info_span, Instrument};

async fn process_order(order_id: String) {
    let span = info_span!("process-order", order.id = %order_id);
    async move {
        // work happens inside the span
        charge_payment(&order_id).await;
    }
    .instrument(span)
    .await;
}
```

## Log Correlation

`tracing` events emitted within a span automatically include the trace and span IDs when bridged through `tracing-opentelemetry`. Standard `tracing::info!`, `tracing::error!` etc. flow through the OTel layer:

```rust
use tracing::{error, info};

#[tracing::instrument]
async fn process_order(order_id: String) {
    info!(order.id = %order_id, "processing order");

    if let Err(e) = charge_payment(&order_id).await {
        error!(error = %e, "payment failed");
    }
}
```

To export logs as OTel log records (rather than only as span events), add the OTLP log exporter:

```toml
[dependencies]
opentelemetry-appender-tracing = "0.27"
```

```rust
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_sdk::logs::LoggerProvider;

let log_exporter = opentelemetry_otlp::LogExporter::builder()
    .with_http()
    .with_endpoint("https://ingest.maple.dev/v1/logs")
    .with_headers([("Authorization".into(), "Bearer YOUR_API_KEY".into())].into_iter().collect())
    .build()?;

let logger_provider = LoggerProvider::builder()
    .with_batch_exporter(log_exporter, runtime::Tokio)
    .with_resource(resource.clone())
    .build();

let otel_log_layer = OpenTelemetryTracingBridge::new(&logger_provider);
// add `.with(otel_log_layer)` to the subscriber registry above
```

## Environment Variables

As an alternative to programmatic configuration, set standard OTel environment variables and let the SDK pick them up:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_SERVICE_NAME="my-rust-app"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The ingest endpoint URL is correct
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
- The provider is shut down before the process exits so buffered spans flush
