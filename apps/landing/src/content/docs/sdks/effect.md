---
title: "Quick start"
description: "OpenTelemetry traces, logs, and metrics for Effect applications across Node.js, Bun, Deno, browsers, and Cloudflare Workers."
group: "Effect SDK"
order: 2
sdk: "effect"
---

`@maple-dev/effect-sdk` provides a pre-configured Effect Layer that sets up OpenTelemetry traces, logs, and metrics for Maple. It wraps Effect's built-in `Otlp.layerJson` exporter, fills in resource attributes from the runtime, and returns a no-op layer when no endpoint is configured — so the same code runs locally without exporting telemetry.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Node.js</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Bun</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Deno</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Cloudflare Workers</span>
</div>

## Install

**Effect 4+**

```bash
npm install @maple-dev/effect-sdk effect
```

**Effect 3**

```bash
npm install @maple-dev/effect-sdk@effect-v3 effect @effect/platform @effect/opentelemetry
```

> The API and import paths are identical between versions. The only differences are the install command and that duration config types use `Duration.DurationInput` instead of `Duration.Input` in Effect 3.

## Pick your platform

The SDK ships three platform-specific entry points. Each one has its own setup story:

- [**Server**](/docs/sdks/effect-server) — Node.js, Bun, Deno. Background-export fiber, env-var auto-detection, graceful shutdown.
- [**Browser**](/docs/sdks/effect-client) — single-page apps. Explicit config (no env vars), browser metadata baked into resource attributes.
- [**Cloudflare Workers**](/docs/sdks/effect-cloudflare) — short-lived isolates. Manual `flush()` in `ctx.waitUntil`, lazy env resolution, in-isolate buffering.

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

`Effect.log` automatically includes trace context when called inside a span — no additional setup needed:

```typescript
const program = Effect.gen(function* () {
	yield* Effect.log("Processing started")
	yield* doWork()
	yield* Effect.log("Processing complete")
}).pipe(Effect.withSpan("process"))
```

Logs emitted inside spans are correlated with the active trace in the Maple dashboard.

## Configuration Reference

All options for `Maple.layer()` (server and browser entry points). The Cloudflare entry point accepts a slightly different shape — see the [Cloudflare page](/docs/sdks/effect-cloudflare) for its config table.

| Option                  | Type                      | Required                   | Description                                                          |
| ----------------------- | ------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `serviceName`           | `string`                  | Yes                        | Service name reported in traces, logs, and metrics                   |
| `endpoint`              | `string`                  | No (server) / Yes (client) | Maple ingest endpoint URL. Server auto-detects from `MAPLE_ENDPOINT` |
| `ingestKey`             | `string`                  | No                         | Maple ingest key. Server auto-detects from `MAPLE_INGEST_KEY`        |
| `serviceVersion`        | `string`                  | No                         | Override auto-detected commit SHA                                    |
| `environment`           | `string`                  | No                         | Override auto-detected deployment environment                        |
| `attributes`            | `Record<string, unknown>` | No                         | Additional resource attributes merged into telemetry                 |
| `maxBatchSize`          | `number`                  | No                         | Max telemetry items per export batch                                 |
| `loggerExportInterval`  | `Duration.Input`          | No                         | Export interval for logs                                             |
| `metricsExportInterval` | `Duration.Input`          | No                         | Export interval for metrics                                          |
| `tracerExportInterval`  | `Duration.Input`          | No                         | Export interval for traces                                           |
| `shutdownTimeout`       | `Duration.Input`          | No                         | Graceful shutdown timeout                                            |

> In Effect 3, duration fields use the `Duration.DurationInput` type instead of `Duration.Input`.
