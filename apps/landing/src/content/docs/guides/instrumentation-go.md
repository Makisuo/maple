---
title: "Go Instrumentation"
description: "Instrument a Go application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Guides"
order: 6
---

This guide covers instrumenting a Go application to send traces and logs to Maple using the OpenTelemetry SDK.

## Prerequisites

- Go 1.21+
- A Maple project with an API key

## Install Dependencies

```bash
go get go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
```

## Configure the SDK

Set up the tracer provider in your application startup:

```go
package main

import (
	"context"
	"log"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

func initTracer(ctx context.Context) (*trace.TracerProvider, error) {
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL("https://ingest.maple.dev/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{
			"Authorization": "Bearer YOUR_API_KEY",
		}),
	)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("my-go-app"),
			semconv.DeploymentEnvironment(os.Getenv("DEPLOYMENT_ENV")),
		),
		resource.WithAttributes(
			semconv.ServiceVersion("1.0.0"),
		),
	)
	if err != nil {
		return nil, err
	}

	tp := trace.NewTracerProvider(
		trace.WithBatcher(exporter),
		trace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	return tp, nil
}

func main() {
	ctx := context.Background()

	tp, err := initTracer(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tp.Shutdown(ctx)

	// Your application code here
}
```

## Instrumentation Libraries

Go does not have auto-discovery of instrumentation. Instead, add instrumentation packages for the libraries you use.

### HTTP Server

Wrap your HTTP handler with `otelhttp`:

```bash
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

mux := http.NewServeMux()
mux.HandleFunc("/api/orders", handleOrders)

// Wrap the entire handler
handler := otelhttp.NewHandler(mux, "server")
http.ListenAndServe(":8080", handler)
```

### HTTP Client

Wrap outgoing HTTP transports to trace client requests:

```go
client := &http.Client{
	Transport: otelhttp.NewTransport(http.DefaultTransport),
}
resp, err := client.Get("https://api.example.com/data")
```

### gRPC

```bash
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
```

```go
import "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

// Server
server := grpc.NewServer(
	grpc.StatsHandler(otelgrpc.NewServerHandler()),
)

// Client
conn, err := grpc.Dial(addr,
	grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
)
```

### Database

```bash
go get github.com/XSAM/otelsql
```

```go
import "github.com/XSAM/otelsql"

db, err := otelsql.Open("postgres", dsn)
```

## Custom Spans

Create custom spans to trace specific operations:

```go
import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var tracer = otel.Tracer("my-app")

func processOrder(ctx context.Context, orderID string) error {
	ctx, span := tracer.Start(ctx, "process-order")
	defer span.End()

	span.SetAttributes(
		attribute.String("order.id", orderID),
		// Set peer.service when calling another service
		attribute.String("peer.service", "payment-api"),
	)

	if err := chargePayment(ctx, orderID); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	return nil
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

Always propagate `ctx` through function calls so child spans are linked to parent spans.

## Log Correlation

### slog Bridge

Use the OTel slog bridge to send structured logs with trace correlation:

```bash
go get go.opentelemetry.io/contrib/bridges/otelslog
```

```go
import "go.opentelemetry.io/contrib/bridges/otelslog"

logger := otelslog.NewLogger("my-app")
logger.InfoContext(ctx, "Order processed", "order_id", orderID)
```

### Manual Correlation

Alternatively, extract trace context and include it in your log fields:

```go
import "go.opentelemetry.io/otel/trace"

span := trace.SpanFromContext(ctx)
sc := span.SpanContext()
logger.Info("Order processed",
	"trace_id", sc.TraceID().String(),
	"span_id", sc.SpanID().String(),
	"order_id", orderID,
)
```

## Environment Variables

As an alternative to programmatic configuration, set standard OTel environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_SERVICE_NAME="my-go-app"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

These variables are read by the OTel SDK automatically when creating exporters with default options.

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:
- The ingest endpoint URL is correct
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
