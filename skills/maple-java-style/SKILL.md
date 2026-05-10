---
name: maple-java-style
description: "Java OpenTelemetry style for Maple: zero-code Java agent or manual SDK with OTLP HTTP exporters, inline endpoint + ingest key, semconv resource attributes, OTLP-bridged Logback / SLF4J logs."
---

# Maple Java style

The fastest path is the OpenTelemetry Java Agent — it auto-instruments the JVM with zero code changes.

## Zero-code: Java agent

```bash
curl -sLO https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

Inline the endpoint and ingest key as JVM args (these are the agent's only configuration surface — they map straight onto the inline-key model):

```bash
java \
  -javaagent:./opentelemetry-javaagent.jar \
  -Dotel.service.name=orders-api \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.headers="authorization=Bearer MAPLE_TEST" \
  -Dotel.resource.attributes="vcs.repository.url.full=https://github.com/acme/orders-api,vcs.ref.head.revision=${GITHUB_SHA:-}" \
  -jar build/libs/app.jar
```

Replace `MAPLE_TEST` with the project's real Maple ingest key once it's available. Keep the args inline (in `Procfile` / `Dockerfile` / `systemd` unit / `application.yml`) — don't move them behind unset env vars.

The agent auto-instruments Spring (Boot, MVC, WebFlux), Servlet containers, Apache HttpClient, OkHttp, JDBC, R2DBC, Hibernate, Kafka, gRPC, AWS SDK, and many more.

## Manual SDK (when the agent isn't an option)

For cases where the agent can't run (GraalVM native image, embedded JVM, sealed module path), use the SDK directly:

```xml
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-api</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-sdk</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry.instrumentation</groupId>
  <artifactId>opentelemetry-logback-appender-1.0</artifactId>
</dependency>
```

```java
public final class Telemetry {
    private static final String MAPLE_ENDPOINT = "https://ingest.maple.dev";
    private static final String MAPLE_KEY = "MAPLE_TEST"; // set by maple-onboard skill on pairing

    public static OpenTelemetrySdk init() {
        var headers = Map.of("authorization", "Bearer " + MAPLE_KEY);
        var resource = Resource.getDefault().merge(Resource.create(Attributes.builder()
            .put(ServiceAttributes.SERVICE_NAME, "orders-api")
            .put(DeploymentIncubatingAttributes.DEPLOYMENT_ENVIRONMENT_NAME,
                System.getenv().getOrDefault("DEPLOYMENT_ENV", "development"))
            .put("vcs.repository.url.full", "https://github.com/acme/orders-api")
            .put("vcs.ref.head.revision", System.getenv().getOrDefault("GITHUB_SHA", ""))
            .build()));

        var spanExporter = OtlpHttpSpanExporter.builder()
            .setEndpoint(MAPLE_ENDPOINT + "/v1/traces")
            .setHeaders(() -> headers)
            .build();
        // … same shape for OtlpHttpLogRecordExporter and OtlpHttpMetricExporter

        return OpenTelemetrySdk.builder()
            .setTracerProvider(SdkTracerProvider.builder()
                .addSpanProcessor(BatchSpanProcessor.builder(spanExporter).build())
                .setResource(resource)
                .build())
            .buildAndRegisterGlobal();
    }
}
```

## Logs

Bridge the existing Logback / SLF4J / Log4j2 setup through OTLP — don't replace it. With the Java agent, log appenders are auto-bridged. With the manual SDK, add the `opentelemetry-logback-appender-1.0` (or the Log4j 2 equivalent) and configure it in `logback.xml` so existing logger calls carry `trace_id` / `span_id` and reach Maple.

## Bounded business spans

Acquire the tracer at class scope; wrap operations the agent's auto-instrumentation can't see.

```java
private static final Tracer TRACER = GlobalOpenTelemetry.getTracer("orders.api");

public Order submit(String orderId, String tenantId) {
    var span = TRACER.spanBuilder("order.submit")
        .setAttribute("tenant.id", tenantId)
        .setAttribute("order.id", orderId)
        .startSpan();
    try (var scope = span.makeCurrent()) {
        return charge(orderId);
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}
```

## Coexistence

If the project already runs Datadog / New Relic / Honeycomb agents, leave them in place. The OpenTelemetry Java Agent coexists with most APMs (test the combination once before shipping). Don't strip an incumbent agent unless the user asks.
