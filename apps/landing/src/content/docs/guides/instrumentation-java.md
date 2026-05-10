---
title: "Java Instrumentation"
description: "Instrument a Java application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 8
sdk: "java"
---

This guide covers instrumenting a Java application to send traces and logs to Maple. The fastest path on the JVM is the OpenTelemetry Java agent, which auto-instruments most popular libraries with zero code changes.

> **Run this with Claude Code:** `maple-onboard` walks every service in the repo, installs OpenTelemetry, and verifies the bootstrap end-to-end. See the [maple-onboard skill](https://github.com/Makisuo/maple/tree/main/skills/maple-onboard).

## Prerequisites

- Java 8+
- A Maple project with an API key (or use the `MAPLE_TEST` placeholder while pairing -- it's accepted by the ingest gateway and discarded, so the bootstrap can run before you've created your first key)

## Option 1: Java Agent (Recommended)

Download the latest agent jar from the [opentelemetry-java-instrumentation releases](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases):

```bash
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

Run your application with the agent attached and Maple's endpoint configured:

```bash
java \
  -javaagent:opentelemetry-javaagent.jar \
  -Dotel.service.name=my-java-app \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.headers="Authorization=Bearer YOUR_API_KEY" \
  -Dotel.resource.attributes="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-java-app" \
  -jar app.jar
```

Or via environment variables (works well in containers):

```bash
export JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar"
export OTEL_SERVICE_NAME="my-java-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-java-app"
```

The agent automatically instruments Spring (MVC, Boot, WebFlux), JDBC, gRPC, Kafka, JMS, AWS SDK, and 100+ other libraries. See the full list in the [agent documentation](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/supported-libraries.md).

## Option 2: Manual SDK Setup

If you can't use the agent (e.g. native images, restricted runtimes), wire the SDK manually.

### Install Dependencies

For Maven:

```xml
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-api</artifactId>
    <version>1.45.0</version>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-sdk</artifactId>
    <version>1.45.0</version>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
    <version>1.45.0</version>
</dependency>
<dependency>
    <groupId>io.opentelemetry.semconv</groupId>
    <artifactId>opentelemetry-semconv</artifactId>
    <version>1.28.0-alpha</version>
</dependency>
```

For Gradle:

```kotlin
implementation("io.opentelemetry:opentelemetry-api:1.45.0")
implementation("io.opentelemetry:opentelemetry-sdk:1.45.0")
implementation("io.opentelemetry:opentelemetry-exporter-otlp:1.45.0")
implementation("io.opentelemetry.semconv:opentelemetry-semconv:1.28.0-alpha")
```

### Configure the SDK

```java
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.semconv.ResourceAttributes;

public class Telemetry {
    public static OpenTelemetry init() {
        Resource resource = Resource.getDefault().merge(
            Resource.create(Attributes.builder()
                .put(ResourceAttributes.SERVICE_NAME, "my-java-app")
                .put(ResourceAttributes.DEPLOYMENT_ENVIRONMENT,
                    System.getenv().getOrDefault("DEPLOYMENT_ENV", "development"))
                .build())
        );

        OtlpHttpSpanExporter exporter = OtlpHttpSpanExporter.builder()
            .setEndpoint("https://ingest.maple.dev/v1/traces")
            .addHeader("Authorization", "Bearer YOUR_API_KEY")
            .build();

        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
            .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())
            .setResource(resource)
            .build();

        OpenTelemetry openTelemetry = OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .buildAndRegisterGlobal();

        Runtime.getRuntime().addShutdownHook(new Thread(tracerProvider::close));

        return openTelemetry;
    }
}
```

Initialize at startup:

```java
public static void main(String[] args) {
    Telemetry.init();
    // your application
}
```

## Custom Spans

```java
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;

private static final Tracer tracer = GlobalOpenTelemetry.getTracer("my-app");

public void processOrder(String orderId) {
    Span span = tracer.spanBuilder("process-order").startSpan();
    try (Scope scope = span.makeCurrent()) {
        span.setAttribute("order.id", orderId);
        // Set peer.service when calling another service
        span.setAttribute("peer.service", "payment-api");
        chargePayment(orderId);
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

## Log Correlation

When using the Java agent with Logback, SLF4J, or Log4j2, trace context (`trace_id`, `span_id`) is automatically injected into MDC. Add the IDs to your log pattern:

```xml
<!-- logback.xml -->
<encoder>
    <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} trace_id=%X{trace_id} span_id=%X{span_id} - %msg%n</pattern>
</encoder>
```

To export logs as OTel log records, enable the agent's log appender:

```bash
-Dotel.logs.exporter=otlp
-Dotel.instrumentation.logback-appender.experimental-log-attributes=true
```

## Spring Boot

Spring Boot apps work out of the box with the Java agent. For native projects (Spring AOT / GraalVM), use the [opentelemetry-spring-boot-starter](https://github.com/open-telemetry/opentelemetry-java-instrumentation/tree/main/instrumentation/spring/spring-boot-autoconfigure) instead, which works without a Java agent attach:

```kotlin
implementation("io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter:2.10.0")
```

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The ingest endpoint URL is correct (use the bare host -- the agent appends `/v1/traces` itself)
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
- `OTEL_EXPORTER_OTLP_PROTOCOL` is set to `http/protobuf` -- the gRPC default won't reach Maple's HTTP ingest
