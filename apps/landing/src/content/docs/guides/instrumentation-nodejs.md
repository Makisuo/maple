---
title: "Node.js Instrumentation"
description: "Instrument a Node.js application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Guides"
order: 3
---

This guide covers instrumenting a Node.js application to send traces and logs to Maple using the OpenTelemetry SDK.

## Prerequisites

- Node.js 18+
- A Maple project with an API key

## Install Dependencies

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-logs-otlp-http
```

## Configure the SDK

Create a `tracing.ts` file that initializes the SDK before your application code:

```typescript
// tracing.ts
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { Resource } from "@opentelemetry/resources"

const sdk = new NodeSDK({
	resource: new Resource({
		"service.name": "my-node-app",
		"deployment.environment": process.env.NODE_ENV || "development",
		"deployment.commit_sha": process.env.COMMIT_SHA,
	}),
	traceExporter: new OTLPTraceExporter({
		url: "https://ingest.maple.dev/v1/traces",
		headers: { Authorization: "Bearer YOUR_API_KEY" },
	}),
	logRecordProcessors: [
		new SimpleLogRecordProcessor(
			new OTLPLogExporter({
				url: "https://ingest.maple.dev/v1/logs",
				headers: { Authorization: "Bearer YOUR_API_KEY" },
			}),
		),
	],
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

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

If you're using Next.js, use the `@vercel/otel` package:

```bash
npm install @vercel/otel @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http
```

```typescript
// instrumentation.ts (project root)
import { registerOTel } from "@vercel/otel"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"

export function register() {
	registerOTel({
		serviceName: "my-next-app",
		attributes: { environment: "production" },
		traceExporter: { url: "https://ingest.maple.dev/v1/traces" },
		logRecordProcessor: new SimpleLogRecordProcessor(
			new OTLPLogExporter({
				url: "https://ingest.maple.dev/v1/logs",
				headers: { Authorization: "Bearer YOUR_API_KEY" },
			}),
		),
	})
}
```

Enable the instrumentation hook in `next.config.ts`:

```typescript
export default {
	experimental: { instrumentationHook: true },
}
```

## Effect

If you're using Effect, see the dedicated [Effect Instrumentation](/docs/guides/instrumentation-effect) guide.

## Verify

1. Start your application
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The ingest endpoint URL is correct
- Your API key is valid
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
