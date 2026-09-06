---
title: "Laravel Instrumentation"
description: "Instrument a Laravel application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 13
navLabel: "Laravel"
sdk: "laravel"
---

This guide covers instrumenting a Laravel application to send traces and logs to Maple using the [`keepsuit/laravel-opentelemetry`](https://github.com/keepsuit/laravel-opentelemetry) package, which wires OpenTelemetry into Laravel's HTTP kernel, database, queue, and logging internals so you get useful spans out of the box.

> **Run this with Claude Code:** `maple-onboard` walks every service in the repo, installs OpenTelemetry, and verifies the bootstrap end-to-end. See the [maple-onboard skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard). Already instrumented? `maple-audit` reviews the existing setup against Maple's conventions and fixes gaps — see the [maple-audit skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit).

## Prerequisites

- PHP 8.1+ and Laravel 10, 11, or 12
- Composer
- A Maple project with an API key (or use the `MAPLE_TEST` placeholder while pairing -- see below)

## Install Dependencies

```bash
composer require keepsuit/laravel-opentelemetry
```

Publish the config so you can toggle individual instrumentations later:

```bash
php artisan vendor:publish \
  --provider="Keepsuit\LaravelOpenTelemetry\LaravelOpenTelemetryServiceProvider" \
  --tag="opentelemetry-config"
```

This installs the OpenTelemetry SDK and the OTLP/HTTP exporter as transitive dependencies. No code changes are required to start — the package auto-registers its middleware and instrumentation via a service provider.

## Configure the SDK

The package is configured entirely through standard OpenTelemetry environment variables. Point it at Maple's ingest endpoint and pass your ingest key as an `Authorization: Bearer` header:

```env
# .env
OTEL_SERVICE_NAME=my-laravel-app

OTEL_TRACES_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp

OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer MAPLE_TEST"
OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer MAPLE_TEST"

OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-laravel-app"
```

`keepsuit/laravel-opentelemetry` reads **per-signal** header variables (`OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS`), so set the `Authorization` header on each signal you export rather than relying on the generic `OTEL_EXPORTER_OTLP_HEADERS`.

> **`MAPLE_TEST` placeholder:** While you're pairing your editor with Maple, the literal string `MAPLE_TEST` is accepted by the ingest gateway and discarded -- so the bootstrap can run end-to-end before you've created your first key. Once you have a real key from **Settings → API Keys**, replace `MAPLE_TEST` in the values above with it.

### Protocol: `http/json` vs `http/protobuf`

Maple's ingest endpoint accepts **both** `http/protobuf` (the OpenTelemetry default) and `http/json`. The difference is on the PHP side:

- **`http/json`** needs no extra extensions and works in any PHP environment — the simplest path to get started, especially inside Docker / Laravel Sail.
- **`http/protobuf`** requires a protobuf implementation. The pure-PHP `google/protobuf` library works but is slow; for production install the protobuf C extension (`pecl install protobuf`, then enable `extension=protobuf.so`). If neither is available, protobuf export fails — which is why a minimal Sail container may need `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

Start with `http/json`; switch to `http/protobuf` once you've installed the protobuf extension and want the smaller, faster payloads.

## Auto-Instrumentation

Once installed, the package automatically creates spans for:

- **HTTP requests** — a server span per incoming request, via middleware
- **Database** — Eloquent / query-builder statements (`QueryInstrumentation`)
- **Queue jobs** — producer and consumer spans, with context propagated across the queue (`QueueInstrumentation`)
- **Redis** — commands (`RedisInstrumentation`)
- **Cache** — hits/misses recorded as span events
- **View rendering** — a span per rendered view
- **Livewire** — a span per component request
- **Events** — recorded as span events (with configurable exclusions)

Each instrumentation can be toggled with `OTEL_INSTRUMENTATION_*` environment variables or by editing the published `config/opentelemetry.php`.

Outgoing HTTP calls made with Laravel's `Http` facade are traced and propagate trace context, so downstream services connect to the same trace:

```php
use Illuminate\Support\Facades\Http;

$response = Http::withTrace()->get('https://payment-api.internal/charge');
```

## Custom Spans

Use the `Tracer` facade to wrap your own operations. `measure()` handles the span lifecycle (start, end, and error recording) for you:

```php
use Keepsuit\LaravelOpenTelemetry\Facades\Tracer;

Tracer::newSpan('process-order')
    ->setAttributes([
        'order.id' => $orderId,
        // Set peer.service when calling another service so it appears on the service map
        'peer.service' => 'payment-api',
    ])
    ->measure(fn () => $this->chargePayment($orderId));
```

For finer control — for example to record an exception and mark the span as failed — manage the span manually. The span object mirrors the OpenTelemetry PHP SDK API (`setAttribute`, `recordException`, `setStatus`):

```php
use Keepsuit\LaravelOpenTelemetry\Facades\Tracer;
use OpenTelemetry\API\Trace\StatusCode;

$span = Tracer::newSpan('process-order')->start();
$scope = $span->activate();

try {
    return $this->chargePayment($orderId);
} catch (\Throwable $e) {
    $span->recordException($e);
    $span->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
    throw $e;
} finally {
    $scope->detach();
    $span->end();
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map). The facade also exposes `Tracer::traceId()`, `Tracer::activeSpan()`, and `Tracer::propagationHeaders()` for correlating logs and propagating context across service boundaries by hand.

## Log Correlation

The package registers an `otlp` log channel that ships your application logs to Maple with the active trace ID attached. Add it to `config/logging.php`:

```php
'channels' => [
    'otlp' => [
        'driver' => 'monolog',
        'handler' => \Keepsuit\LaravelOpenTelemetry\Support\OpenTelemetryMonologHandler::class,
        'level' => 'debug',
    ],

    // Or add 'otlp' to an existing stack so logs go to both files and Maple:
    'stack' => [
        'driver' => 'stack',
        'channels' => ['single', 'otlp'],
    ],
],
```

Then route logging to it with `LOG_CHANNEL=otlp` (or `LOG_CHANNEL=stack`) in your `.env`. Trace IDs are injected into log records automatically (the `inject_trace_id` config option, enabled by default), so logs line up with the trace that produced them in the Maple dashboard.

## Local Mode / Docker (Laravel Sail)

When you're testing against a Maple instance running on your host — either [local mode](/docs/local-mode) (`maple start`) or the local collector — your app's exporter lives **inside** the Sail container and must reach back out to the host. Use `host.docker.internal` and the OTLP/HTTP port (`4318`):

```env
# .env (pointing a Sail container at a local Maple on the host)
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Notes for local testing:

- **No `Authorization` header is needed** in local mode — drop the `OTEL_EXPORTER_OTLP_*_HEADERS` variables.
- The local-mode server accepts both protobuf and JSON, but the PHP-side protobuf caveat above still applies — if you haven't installed the protobuf extension in your Sail image, keep `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.
- On Linux hosts where `host.docker.internal` isn't resolvable by default, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service in `docker-compose.yml`.

## Verify

1. Start your application and send a request (or trigger a queued job)
2. Open the Maple dashboard and check that traces appear in the traces view, with spans for the request, queries, and any jobs
3. Confirm logs show up correlated to their trace if you enabled the `otlp` channel

If traces aren't appearing, verify:

- The ingest endpoint URL is correct (`https://ingest.maple.dev`, or `http://host.docker.internal:4318` for local mode)
- Your API key is valid and set on `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_LOGS_HEADERS`
- The container can reach the endpoint (`curl` it from inside the container)
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` if the protobuf extension isn't installed
