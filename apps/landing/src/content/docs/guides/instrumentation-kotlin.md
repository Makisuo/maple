---
title: "Kotlin Instrumentation"
description: "Instrument a Kotlin JVM application (Ktor, Spring Boot) with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Guides"
order: 10
sdk: "kotlin"
---

This guide covers instrumenting a Kotlin JVM application (Ktor, Spring Boot, generic JVM) to send traces and logs to Maple. For Android, see the [opentelemetry-android](https://github.com/open-telemetry/opentelemetry-android) project.

## Prerequisites

- Kotlin 1.9+ on JDK 11+
- A Maple project with an API key

## Option 1: Java Agent (Recommended)

Kotlin runs on the JVM, so the OpenTelemetry Java agent works with zero code changes -- it auto-instruments Ktor, Spring, gRPC, JDBC, Kafka, and 100+ other libraries.

Download the agent jar from the [latest release](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases):

```bash
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

Run your app with the agent attached:

```bash
java \
  -javaagent:opentelemetry-javaagent.jar \
  -Dotel.service.name=my-kotlin-app \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.headers="Authorization=Bearer YOUR_API_KEY" \
  -jar build/libs/app.jar
```

Or via environment variables (preferred in containers):

```bash
export JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar"
export OTEL_SERVICE_NAME="my-kotlin-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

## Option 2: Manual SDK Setup

Use this when you can't attach the agent (native images, restricted runtimes, fine-grained control).

### Install Dependencies

In `build.gradle.kts`:

```kotlin
dependencies {
    implementation("io.opentelemetry:opentelemetry-api:1.45.0")
    implementation("io.opentelemetry:opentelemetry-sdk:1.45.0")
    implementation("io.opentelemetry:opentelemetry-exporter-otlp:1.45.0")
    implementation("io.opentelemetry.semconv:opentelemetry-semconv:1.28.0-alpha")
}
```

### Configure the SDK

```kotlin
// Telemetry.kt
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.resources.Resource
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor
import io.opentelemetry.semconv.ResourceAttributes

object Telemetry {
    fun init(): OpenTelemetry {
        val resource = Resource.getDefault().merge(
            Resource.create(
                Attributes.builder()
                    .put(ResourceAttributes.SERVICE_NAME, "my-kotlin-app")
                    .put(
                        ResourceAttributes.DEPLOYMENT_ENVIRONMENT,
                        System.getenv("DEPLOYMENT_ENV") ?: "development",
                    )
                    .build()
            )
        )

        val exporter = OtlpHttpSpanExporter.builder()
            .setEndpoint("https://ingest.maple.dev/v1/traces")
            .addHeader("Authorization", "Bearer YOUR_API_KEY")
            .build()

        val tracerProvider = SdkTracerProvider.builder()
            .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())
            .setResource(resource)
            .build()

        val openTelemetry = OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .buildAndRegisterGlobal()

        Runtime.getRuntime().addShutdownHook(Thread { tracerProvider.close() })

        return openTelemetry
    }
}

fun main() {
    Telemetry.init()
    // your application
}
```

## Ktor

Ktor has a first-party OpenTelemetry plugin for both server and client:

```kotlin
dependencies {
    implementation("io.opentelemetry.instrumentation:opentelemetry-ktor-3.0:2.10.0-alpha")
}
```

Server install:

```kotlin
import io.ktor.server.application.*
import io.opentelemetry.instrumentation.ktor.v3_0.server.KtorServerTracing

fun Application.configureMonitoring() {
    install(KtorServerTracing) {
        setOpenTelemetry(Telemetry.init())
    }
}
```

Client install:

```kotlin
val client = HttpClient(CIO) {
    install(KtorClientTracing) {
        setOpenTelemetry(GlobalOpenTelemetry.get())
    }
}
```

## Spring Boot (Kotlin)

Spring Boot apps written in Kotlin work identically to Java apps. Use the Java agent (Option 1 above), or for Spring AOT / GraalVM native images use the OpenTelemetry Spring Boot starter:

```kotlin
implementation("io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter:2.10.0")
```

## Custom Spans

```kotlin
import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.trace.StatusCode

private val tracer = GlobalOpenTelemetry.getTracer("my-app")

suspend fun processOrder(orderId: String) {
    val span = tracer.spanBuilder("process-order").startSpan()
    span.makeCurrent().use {
        try {
            span.setAttribute("order.id", orderId)
            // Set peer.service when calling another service
            span.setAttribute("peer.service", "payment-api")
            chargePayment(orderId)
        } catch (e: Exception) {
            span.recordException(e)
            span.setStatus(StatusCode.ERROR, e.message ?: "")
            throw e
        } finally {
            span.end()
        }
    }
}
```

A small extension function makes this cleaner:

```kotlin
inline fun <T> Tracer.span(name: String, block: (Span) -> T): T {
    val span = spanBuilder(name).startSpan()
    return span.makeCurrent().use {
        try {
            block(span)
        } catch (e: Throwable) {
            span.recordException(e)
            span.setStatus(StatusCode.ERROR, e.message ?: "")
            throw e
        } finally {
            span.end()
        }
    }
}

// Usage
tracer.span("process-order") { span ->
    span.setAttribute("order.id", orderId)
    chargePayment(orderId)
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

## Log Correlation

With the Java agent, trace and span IDs are auto-injected into the MDC for SLF4J / Logback / Log4j2. Reference them in your log pattern:

```xml
<!-- src/main/resources/logback.xml -->
<encoder>
    <pattern>%d{HH:mm:ss.SSS} %-5level trace_id=%X{trace_id} span_id=%X{span_id} - %msg%n</pattern>
</encoder>
```

To export logs as OTel log records, enable the agent's log appender:

```bash
-Dotel.logs.exporter=otlp
```

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The agent endpoint is just the host (`https://ingest.maple.dev`); the agent appends `/v1/traces`
- `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf` -- the default `grpc` won't reach Maple's ingest
- Your API key is valid and the application can reach `ingest.maple.dev`
