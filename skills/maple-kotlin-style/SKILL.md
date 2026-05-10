---
name: maple-kotlin-style
description: "Kotlin (Ktor, Spring Boot) OpenTelemetry style for Maple: zero-code Java agent or manual SDK with OTLP HTTP exporters, inline endpoint + ingest key, semconv resource attributes, OTLP-bridged logs."
---

# Maple Kotlin style

Kotlin runs on the JVM, so the same OpenTelemetry Java agent and SDK apply. Prefer the agent for Spring Boot / Ktor servers; fall back to the manual SDK only for native-image or sealed-module builds.

## Zero-code: Java agent (recommended)

```bash
curl -sLO https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

java \
  -javaagent:./opentelemetry-javaagent.jar \
  -Dotel.service.name=orders-api \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.headers="authorization=Bearer MAPLE_TEST" \
  -Dotel.resource.attributes="vcs.repository.url.full=https://github.com/acme/orders-api,vcs.ref.head.revision=${GITHUB_SHA:-}" \
  -jar build/libs/app.jar
```

Replace `MAPLE_TEST` with the project's real Maple ingest key once available. Keep these flags inline (in `Procfile` / `Dockerfile` / `application.yml`) — don't move them behind unset env vars.

The agent auto-instruments Ktor, Spring Boot (MVC, WebFlux), Coroutines, Exposed, R2DBC, Kafka, gRPC, OkHttp, AWS SDK, and many more.

## Manual SDK (Ktor, no agent)

```kotlin
val MAPLE_ENDPOINT = "https://ingest.maple.dev"
val MAPLE_KEY = "MAPLE_TEST" // set by maple-onboard skill on pairing

fun initTelemetry(): OpenTelemetrySdk {
    val headers = mapOf("authorization" to "Bearer $MAPLE_KEY")
    val resource = Resource.getDefault().merge(Resource.create(
        Attributes.builder()
            .put(ServiceAttributes.SERVICE_NAME, "orders-api")
            .put(DeploymentIncubatingAttributes.DEPLOYMENT_ENVIRONMENT_NAME,
                System.getenv("DEPLOYMENT_ENV") ?: "development")
            .put("vcs.repository.url.full", "https://github.com/acme/orders-api")
            .put("vcs.ref.head.revision", System.getenv("GITHUB_SHA") ?: "")
            .build()))

    val spanExporter = OtlpHttpSpanExporter.builder()
        .setEndpoint("$MAPLE_ENDPOINT/v1/traces")
        .setHeaders { headers }
        .build()

    return OpenTelemetrySdk.builder()
        .setTracerProvider(SdkTracerProvider.builder()
            .addSpanProcessor(BatchSpanProcessor.builder(spanExporter).build())
            .setResource(resource)
            .build())
        .buildAndRegisterGlobal()
}
```

Add the equivalent log + metric exporters in the same builder.

## Bounded business spans

```kotlin
private val tracer = GlobalOpenTelemetry.getTracer("orders.api")

suspend fun submitOrder(orderId: String, tenantId: String) {
    val span = tracer.spanBuilder("order.submit")
        .setAttribute("tenant.id", tenantId)
        .setAttribute("order.id", orderId)
        .startSpan()
    try {
        span.makeCurrent().use {
            chargeOrder(orderId)
        }
    } catch (e: Exception) {
        span.recordException(e)
        span.setStatus(StatusCode.ERROR, e.message ?: "")
        throw e
    } finally {
        span.end()
    }
}
```

For coroutines, use the `kotlinx-coroutines-extension` (`opentelemetry-kotlin-extension`) so context propagates across `withContext` boundaries.

## Logs

Bridge whatever the project uses (Logback, SLF4J, Log4j2). With the agent, log appenders are auto-bridged. With the manual SDK, add `opentelemetry-logback-appender-1.0` (or Log4j 2 equivalent) and configure it in `logback.xml` so existing logger calls carry `trace_id` / `span_id` and reach Maple. Don't replace the user's existing logger.

## Coexistence

If the project runs Datadog / New Relic / Honeycomb, leave them in place. Test the combination once before shipping.
