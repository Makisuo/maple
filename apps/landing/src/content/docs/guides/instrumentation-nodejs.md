---
title: "Node.js Instrumentation"
description: "Instrument a Node.js application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 3
sdk: "node"
---

This guide covers instrumenting a Node.js application to send traces and logs to Maple using the OpenTelemetry SDK.

> **Run this with Claude Code:** `maple-onboard` walks every service in the repo, installs OpenTelemetry, and verifies the bootstrap end-to-end. See the [maple-onboard skill](https://github.com/Makisuo/maple/tree/main/skills/maple-onboard).

## Prerequisites

- Node.js 18+
- A Maple project with an API key (or use the `MAPLE_TEST` placeholder while pairing -- see below)

## Install Dependencies

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-logs-otlp-http
```

## Configure the SDK

Create a `tracing.ts` file that initializes the SDK before your application code. **Inline the endpoint and ingest key** -- the key is project-scoped and write-only (Sentry-DSN-shaped), so source-level configuration removes a class of "OTel didn't start because env vars weren't set" deploy failures.

```typescript
// tracing.ts
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { resourceFromAttributes } from "@opentelemetry/resources"

const MAPLE_ENDPOINT = "https://ingest.maple.dev"
const MAPLE_KEY = "MAPLE_TEST" // replace with your real key from Settings → API Keys

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "my-node-app",
		"deployment.environment.name": process.env.NODE_ENV || "development",
		"vcs.repository.url.full": "https://github.com/acme/my-node-app",
		"vcs.ref.head.revision":
			process.env.RAILWAY_GIT_COMMIT_SHA ??
			process.env.GITHUB_SHA ??
			process.env.GIT_COMMIT,
	}),
	traceExporter: new OTLPTraceExporter({
		url: `${MAPLE_ENDPOINT}/v1/traces`,
		headers,
	}),
	logRecordProcessors: [
		new SimpleLogRecordProcessor(
			new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers }),
		),
	],
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

> **`MAPLE_TEST` placeholder:** While you're pairing your editor with Maple, the literal string `MAPLE_TEST` is accepted by the ingest gateway and discarded -- so the bootstrap can run end-to-end before you've created your first key. Once you have a real key, search-replace `MAPLE_TEST` in the file above with it.

Run your application with the tracing file loaded first:

```bash
node --import ./tracing.ts app.ts
```

> If you're using TypeScript directly, run with a loader like [tsx](https://github.com/privatenumber/tsx): `node --import tsx/esm --import ./tracing.ts app.ts`

## Auto-Instrumentation

`getNodeAutoInstrumentations()` automatically instruments common libraries including HTTP, Express, Fastify, pg, MySQL, Redis, and many more.

To disable specific instrumentations:

```typescript
instrumentations: [
  getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-dns": { enabled: false },
  }),
],
```

## Custom Spans

Create custom spans to trace specific operations in your code:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("my-app")

async function processOrder(orderId: string) {
	return tracer.startActiveSpan("process-order", async (span) => {
		try {
			span.setAttribute("order.id", orderId)
			// Set peer.service when calling another service
			span.setAttribute("peer.service", "payment-api")
			const result = await chargePayment(orderId)
			return result
		} catch (error) {
			span.recordException(error as Error)
			span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
			throw error
		} finally {
			span.end()
		}
	})
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

## Log Correlation

The OpenTelemetry log SDK automatically includes trace context (`TraceId`, `SpanId`) with log records emitted during an active span. This enables correlated log views in Maple.

For structured logging with pino, use `pino-opentelemetry-transport` to bridge pino logs to the OTel log SDK.

## Next.js

Using Next.js? See the dedicated [Next.js Instrumentation](/docs/guides/instrumentation-nextjs) guide -- it walks through `@vercel/otel` and the App Router / Pages Router specifics.

## Effect

If you're using Effect, see the dedicated [Effect SDK](/docs/sdks/effect) -- it's the official Maple library for Effect apps.

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The ingest endpoint URL is correct
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
