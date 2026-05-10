---
name: maple-go-style
description: "Go OpenTelemetry style for Maple: go.opentelemetry.io/otel SDK with otlptracehttp / otlploghttp / otlpmetrichttp exporters, inline endpoint + ingest key, semconv resource attributes including vcs.repository.url.full."
---

# Maple Go style

Use the official `go.opentelemetry.io/otel` SDK with the HTTP exporters. Initialize once at process start and shut down on signal.

## Install

```bash
go get \
  go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
  go.opentelemetry.io/otel/exporters/otlp/otlplogs/otlploghttp \
  go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp \
  go.opentelemetry.io/otel/log \
  go.opentelemetry.io/otel/sdk/log
```

## Bootstrap

Inline the endpoint and ingest key — they're a project-scoped, write-only token (Sentry-DSN-shaped). No env-var indirection.

```go
package telemetry

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplogs/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

const (
	mapleEndpoint = "ingest.maple.dev"
	mapleKey      = "MAPLE_TEST" // set by maple-onboard skill on pairing
)

func Init(ctx context.Context) (shutdown func(context.Context) error, err error) {
	headers := map[string]string{"authorization": "Bearer " + mapleKey}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("orders-api"),
			semconv.DeploymentEnvironment(envOr("DEPLOYMENT_ENV", "development")),
			attribute.String("vcs.repository.url.full", "https://github.com/acme/orders-api"),
			attribute.String("vcs.ref.head.revision", envOr("GITHUB_SHA", envOr("GIT_COMMIT", ""))),
		),
	)
	if err != nil {
		return nil, err
	}

	traceExp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(mapleEndpoint),
		otlptracehttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	tp := trace.NewTracerProvider(trace.WithBatcher(traceExp), trace.WithResource(res))
	otel.SetTracerProvider(tp)

	logExp, err := otlploghttp.New(ctx,
		otlploghttp.WithEndpoint(mapleEndpoint),
		otlploghttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
		sdklog.WithResource(res),
	)
	global.SetLoggerProvider(lp)

	metricExp, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpoint(mapleEndpoint),
		otlpmetrichttp.WithHeaders(headers),
	)
	if err != nil {
		return nil, err
	}
	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExp)),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	return func(ctx context.Context) error {
		_ = tp.Shutdown(ctx)
		_ = lp.Shutdown(ctx)
		return mp.Shutdown(ctx)
	}, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

Wire from `main`:

```go
func main() {
	ctx := context.Background()
	shutdown, err := telemetry.Init(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer shutdown(ctx)

	// app start
}
```

## Bounded business spans

Acquire the tracer at package scope, start spans where auto-instrumentation is blind, set the status on error, end the span via `defer`.

```go
var tracer = otel.Tracer("orders.api")

func SubmitOrder(ctx context.Context, orderID string) (err error) {
	ctx, span := tracer.Start(ctx, "order.submit")
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}()

	span.SetAttributes(attribute.String("order.id", orderID))
	return chargeOrder(ctx, orderID)
}
```

## Auto-instrumentation

Go does not have framework-level auto-discovery. Add the official contrib packages for the libraries the app actually uses (`otelhttp`, `otelgrpc`, `otelsql`, `otelpgx`, `otelmux`, `otelfiber`, etc.). Don't add packages the app doesn't import.

## Coexistence

If the project already exports to Honeycomb / Datadog / Tempo, install Maple's exporter alongside via `trace.WithBatcher(traceExp)` for each backend. Don't strip the existing exporter unless the user asks.
