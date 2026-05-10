---
name: maple-effect-style
description: "Effect-TS OpenTelemetry style for Maple via @maple-dev/effect-sdk: Maple.layer() bootstrap, Effect.withSpan / Effect.annotateCurrentSpan call sites, Effect.log for trace-correlated logging, server / browser / Cloudflare entry points."
---

# Maple Effect style

For Effect apps, use `@maple-dev/effect-sdk` — Maple's first-class Effect SDK. It wraps Effect's built-in `Otlp.layerJson` exporter and handles batching, shutdown, and resource attributes for you.

## Install

```bash
npm install @maple-dev/effect-sdk effect
```

For Effect 3, use `@maple-dev/effect-sdk@effect-v3` instead. Same API, different peer ranges.

## Bootstrap

Pick the entry point per runtime — they have different lifecycle requirements:

- **Server (Node.js, Bun, Deno):** background-export fiber, env-var auto-detection, graceful shutdown.
- **Browser:** explicit config (no env vars), browser metadata baked in.
- **Cloudflare Workers:** manual `flush()` in `ctx.waitUntil`, lazy env resolution, in-isolate buffering.

### Server

```ts
import { Maple } from "@maple-dev/effect-sdk"
import { Effect, Layer } from "effect"

const TracerLive = Maple.layer({
	serviceName: "orders-api",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "MAPLE_TEST", // set by maple-onboard skill on pairing
	attributes: {
		"vcs.repository.url.full": "https://github.com/acme/orders-api",
	},
})

const program = Effect.gen(function* () {
	yield* Effect.log("Order received")
}).pipe(Effect.withSpan("order.submit"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

The default import resolves to the server build under Node.js. Import `@maple-dev/effect-sdk/server` explicitly when needed.

If `endpoint` is omitted, the server layer auto-detects it from `MAPLE_ENDPOINT` (falling back to `OTEL_EXPORTER_OTLP_ENDPOINT`). When `MAPLE_ENDPOINT` is unset, the layer is a no-op — local dev runs without exporting. Inline the endpoint when you want telemetry to flow regardless of env (matches the rest of the maple-onboard inline-key pattern).

The server layer also auto-fills `vcs.ref.head.revision` from `COMMIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_SHA` / `CF_PAGES_COMMIT_SHA` / `RENDER_GIT_COMMIT` (first match wins). You should still set `vcs.repository.url.full` in `attributes` since no env var carries it.

### Cloudflare Workers

```ts
import { Maple } from "@maple-dev/effect-sdk/cloudflare"
import { Effect } from "effect"

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const TracerLive = Maple.layer({
			serviceName: "orders-edge",
			endpoint: "https://ingest.maple.dev",
			ingestKey: "MAPLE_TEST",
		})

		const program = Effect.gen(function* () {
			yield* Effect.log("edge request")
			return new Response("ok")
		}).pipe(Effect.withSpan("edge.handle"))

		const response = await Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
		ctx.waitUntil(Maple.flush())
		return response
	},
}
```

The Cloudflare entry point requires `ctx.waitUntil(Maple.flush())` so telemetry survives the isolate exit. Forgetting this is the most common reason traces don't show up from Workers.

### Browser

```ts
import { Maple } from "@maple-dev/effect-sdk/browser"

const TracerLive = Maple.layer({
	serviceName: "web-client",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "MAPLE_TEST",
})
```

No env-var fallback in the browser entry point — config is always explicit.

## Custom spans

Use `Effect.withSpan` to trace operations and `Effect.annotateCurrentSpan` for attributes — don't reach for the raw `@opentelemetry/api` tracer when an Effect-native primitive is available.

```ts
const processOrder = (orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("order.id", orderId)
		yield* Effect.annotateCurrentSpan("peer.service", "payment-api")
		const result = yield* chargePayment(orderId)
		return result
	}).pipe(Effect.withSpan("order.process"))
```

Setting `peer.service` on outgoing calls makes them visible on Maple's service map.

`Effect.fail` and uncaught defects are recorded as exceptions and set the span status to ERROR automatically — you don't need to wrap with `try` / `catch` / `finally`.

`@maple/otel-helpers` `withSpan` is for non-Effect TypeScript code; in Effect code prefer the Effect-native span primitives.

## Logs

`Effect.log` automatically includes trace context when called inside a span — no additional setup needed:

```ts
const program = Effect.gen(function* () {
	yield* Effect.log("Processing started")
	yield* doWork()
	yield* Effect.log("Processing complete")
}).pipe(Effect.withSpan("process"))
```

Logs emitted inside spans are correlated with the active trace in the Maple dashboard.

## Coexistence

If the project already uses `@effect/opentelemetry` or `Otlp.layerJson` with a custom exporter (e.g. for Honeycomb, Datadog), keep it. `Maple.layer()` can compose alongside via `Layer.merge`:

```ts
const TracerLive = Layer.merge(
	Maple.layer({ serviceName: "api", endpoint: "https://ingest.maple.dev", ingestKey: "MAPLE_TEST" }),
	HoneycombLayer,
)
```

Both vendors receive the same spans.
