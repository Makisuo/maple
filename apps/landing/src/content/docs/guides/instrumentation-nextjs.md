---
title: "Next.js Instrumentation"
description: "Instrument a Next.js application with @vercel/otel and send traces, logs, and metrics to Maple."
group: "Guides"
order: 4
sdk: "nextjs"
---

This guide covers instrumenting a Next.js application -- App Router, Pages Router, route handlers, and middleware -- using `@vercel/otel` and shipping traces and logs to Maple.

## Prerequisites

- Next.js 13.4+ (the instrumentation hook landed in `experimental.instrumentationHook`; it is enabled by default in 15.x)
- Node.js 18+
- A Maple project with an API key

## Install Dependencies

```bash
npm install @vercel/otel \
  @opentelemetry/api \
  @opentelemetry/sdk-logs \
  @opentelemetry/exporter-logs-otlp-http
```

`@vercel/otel` bundles the trace exporter, span processor, and runtime detection. The standalone `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http` packages are only needed if you want OpenTelemetry log records alongside traces.

## Configure the SDK

Create an `instrumentation.ts` file at the **project root** (not inside `app/` or `src/`). Next.js calls `register()` exactly once on cold start of every runtime.

```typescript
// instrumentation.ts
import { registerOTel } from "@vercel/otel"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"

export function register() {
	registerOTel({
		serviceName: "my-next-app",
		attributes: {
			"deployment.environment": process.env.NODE_ENV ?? "development",
			"deployment.commit_sha": process.env.VERCEL_GIT_COMMIT_SHA,
		},
		traceExporter: {
			url: "https://ingest.maple.dev/v1/traces",
			headers: { Authorization: "Bearer YOUR_API_KEY" },
		},
		logRecordProcessor: new SimpleLogRecordProcessor(
			new OTLPLogExporter({
				url: "https://ingest.maple.dev/v1/logs",
				headers: { Authorization: "Bearer YOUR_API_KEY" },
			}),
		),
	})
}
```

## Enable the Instrumentation Hook

On Next.js 13.4–14, opt in via `next.config.ts`. Skip this on 15+ (it's the default).

```typescript
// next.config.ts
export default {
	experimental: { instrumentationHook: true },
}
```

## Auto-Instrumented Signals

`@vercel/otel` automatically captures spans for:

- **Pages and route handlers** -- every request to an App Router page, Pages Router page, or route handler gets an HTTP server span with method, status code, route, and duration
- **Server Components** -- rendering and data fetching in RSCs are wrapped in spans
- **Middleware** -- `middleware.ts` execution including redirects and rewrites
- **Outgoing fetch calls** -- `fetch()` from server code is instrumented and propagates trace context to downstream services
- **Database clients** -- Prisma, Drizzle, and other instrumented clients pick up the active span automatically

## Custom Spans

Wrap business logic in custom spans to make it visible in the trace tree:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("my-next-app")

export async function processOrder(orderId: string) {
	return tracer.startActiveSpan("process-order", async (span) => {
		try {
			span.setAttribute("order.id", orderId)
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

Logs emitted during an active server span automatically include `TraceId` and `SpanId`, so a click in Maple's logs view jumps straight to the producing trace. If you're using a structured logger (pino, winston) on the server, configure it to emit OTel log records via the same `OTLPLogExporter` you wired into `registerOTel`.

## Edge Runtime

The Edge runtime supports `@vercel/otel` with the same `instrumentation.ts` file. Span and log records are flushed at the end of each request because Edge isolates terminate quickly -- there's no long-lived batch processor.

## Verify

1. Deploy or `next dev` your application
2. Hit a page or API route to generate traffic
3. Open the Maple dashboard and check that traces appear in the traces view -- you should see one root HTTP span per request, with nested fetch and database spans

If traces aren't appearing, verify:

- The ingest endpoint URL is correct
- Your API key is valid
- `instrumentation.ts` is at the project root, not in `app/` or `src/`
- On 13.4–14: `experimental.instrumentationHook` is enabled in `next.config.ts`
- Your application can reach `ingest.maple.dev` (or your self-hosted URL)
