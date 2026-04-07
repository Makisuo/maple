---
title: "Effect Instrumentation"
description: "Instrument an Effect application with the Maple SDK to send traces, logs, and metrics."
group: "Guides"
order: 4
---

The `@maple-dev/effect-sdk` provides a pre-configured Effect Layer that sets up OpenTelemetry traces, logs, and metrics for Maple. It auto-detects platform environment variables and returns a no-op layer when no endpoint is configured, making it safe for local development.

## Prerequisites

- Effect 4+ (or Effect 3 — see below)
- A Maple project with an API key

## Install Dependencies

**Effect 4+**

```bash
npm install @maple-dev/effect-sdk effect
```

**Effect 3**

```bash
npm install @maple-dev/effect-sdk@effect-v3 effect @effect/platform @effect/opentelemetry
```

> The API and import paths are identical between versions. The only differences are the install command and that duration config types use `Duration.DurationInput` instead of `Duration.Input` in Effect 3.

## Server Setup

```typescript
import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

const TracerLive = Maple.layer({
  serviceName: "my-effect-app",
})

const program = Effect.gen(function* () {
  yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

Set `MAPLE_ENDPOINT` and `MAPLE_INGEST_KEY` in your environment and the SDK picks them up automatically. If `MAPLE_ENDPOINT` is not set, the layer is a no-op -- your app runs without exporting telemetry.

## Client Setup

For browser environments, use the client import. All configuration must be provided explicitly since browsers can't read environment variables:

```typescript
import { Maple } from "@maple-dev/effect-sdk/client"
import { Effect } from "effect"

const TracerLive = Maple.layer({
  serviceName: "my-frontend",
  endpoint: "https://ingest.maple.dev",
  ingestKey: "maple_pk_...",
})
```

The client layer automatically captures `browser.user_agent`, `browser.language`, and `browser.timezone` as resource attributes.

## Custom Spans

Use `Effect.withSpan` to trace operations. Add attributes with `Effect.annotateCurrentSpan`:

```typescript
import { Effect } from "effect"

const processOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("order.id", orderId)
    yield* Effect.annotateCurrentSpan("peer.service", "payment-api")
    const result = yield* chargePayment(orderId)
    return result
  }).pipe(Effect.withSpan("process-order"))
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

## Log Correlation

`Effect.log` automatically includes trace context when called inside a span -- no additional setup needed:

```typescript
const program = Effect.gen(function* () {
  yield* Effect.log("Processing started")
  yield* doWork()
  yield* Effect.log("Processing complete")
}).pipe(Effect.withSpan("process"))
```

Logs emitted inside spans are correlated with the active trace in the Maple dashboard.

## Configuration Reference

All options for `Maple.layer()`:

| Option | Type | Required | Description |
|---|---|---|---|
| `serviceName` | `string` | Yes | Service name reported in traces, logs, and metrics |
| `endpoint` | `string` | No (server) / Yes (client) | Maple ingest endpoint URL. Server auto-detects from `MAPLE_ENDPOINT` |
| `ingestKey` | `string` | No | Maple ingest key. Server auto-detects from `MAPLE_INGEST_KEY` |
| `serviceVersion` | `string` | No | Override auto-detected commit SHA |
| `environment` | `string` | No | Override auto-detected deployment environment |
| `attributes` | `Record<string, unknown>` | No | Additional resource attributes merged into telemetry |
| `maxBatchSize` | `number` | No | Max telemetry items per export batch |
| `loggerExportInterval` | `Duration.Input` | No | Export interval for logs |
| `metricsExportInterval` | `Duration.Input` | No | Export interval for metrics |
| `tracerExportInterval` | `Duration.Input` | No | Export interval for traces |
| `shutdownTimeout` | `Duration.Input` | No | Graceful shutdown timeout |

> In Effect 3, duration fields use the `Duration.DurationInput` type instead of `Duration.Input`.

## Environment Variable Auto-Detection

The server layer automatically resolves configuration from environment variables:

**Ingest endpoint:** `MAPLE_ENDPOINT`

**Ingest key:** `MAPLE_INGEST_KEY`

**Commit SHA** (first match wins):
1. `COMMIT_SHA`
2. `RAILWAY_GIT_COMMIT_SHA`
3. `VERCEL_GIT_COMMIT_SHA`
4. `CF_PAGES_COMMIT_SHA`
5. `RENDER_GIT_COMMIT`

**Deployment environment** (first match wins):
1. `MAPLE_ENVIRONMENT`
2. `RAILWAY_ENVIRONMENT`
3. `VERCEL_ENV`
4. `NODE_ENV`

The SDK also auto-detects **runtime** (Node.js, Bun, Deno) and **cloud provider** (Railway, Vercel, Cloudflare, etc.) and includes them as `maple.runtime` and `maple.provider` resource attributes.

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:
- `MAPLE_ENDPOINT` is set correctly
- `MAPLE_INGEST_KEY` is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
