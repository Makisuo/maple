---
title: "Go"
description: "Send traces from a Go service to Maple Local with the OpenTelemetry Go SDK's otlptracehttp exporter."
group: "Sending Data"
order: 4
---

Go has no zero-code agent — you wire the SDK in `main()` and add instrumentation libraries (e.g. `otelhttp`) around your handlers and clients.

## Install

```bash
go get go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

## Setup

```go
package main

import (
	"context"
	"log"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func main() {
	ctx := context.Background()

	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint("127.0.0.1:4318"),
		otlptracehttp.WithInsecure(), // local server is plain HTTP
	)
	if err != nil {
		log.Fatal(err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName("my-go-service"),
		)),
	)
	defer tp.Shutdown(ctx)
	otel.SetTracerProvider(tp)

	handler := otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}), "root")

	log.Fatal(http.ListenAndServe(":8080", handler))
}
```

The env-var route works too — `otlptracehttp.New(ctx)` with no options honors `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.

## Verify

```bash
maple services
maple traces --service my-go-service --since 5m
```
