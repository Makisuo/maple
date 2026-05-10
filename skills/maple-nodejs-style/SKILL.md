---
name: maple-nodejs-style
description: "Plain Node.js (Express, Fastify, Hono, Bun) OpenTelemetry style for Maple: NodeSDK + --import bootstrap, native @opentelemetry/api call sites, inline endpoint + ingest key, OTLP HTTP exporters."
---

# Maple Node.js style

Use `@opentelemetry/sdk-node` with `--import` (or the equivalent Bun `--preload`) so the SDK starts before any framework code runs.

```ts
// telemetry.ts
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { resourceFromAttributes } from "@opentelemetry/resources"

const MAPLE_ENDPOINT = "https://ingest.maple.dev"
const MAPLE_KEY = "MAPLE_TEST" // set by maple-onboard skill on pairing

const headers = { authorization: `Bearer ${MAPLE_KEY}` }

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "my-node-app",
		"deployment.environment.name": process.env.NODE_ENV ?? "development",
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
		new BatchLogRecordProcessor(
			new OTLPLogExporter({ url: `${MAPLE_ENDPOINT}/v1/logs`, headers }),
		),
	],
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({
			url: `${MAPLE_ENDPOINT}/v1/metrics`,
			headers,
		}),
	}),
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

Run the app with the bootstrap loaded first:

```bash
node --import ./telemetry.js app.js
```

For TypeScript projects, use the loader the repo already uses (`tsx`, `ts-node/esm`, native Bun, etc.) — do not introduce a new loader.

## Bootstrap rules

- HTTP OTLP exporters only, never gRPC. gRPC pulls in native bindings that complicate containers.
- `getNodeAutoInstrumentations()` covers HTTP, Express, Fastify, Hono, pg, MySQL, Redis, and many more out of the box. Disable specific instrumentations only when they actively break the app:
	```ts
	getNodeAutoInstrumentations({
		"@opentelemetry/instrumentation-fs": { enabled: false },
	})
	```
- For Bun, use the same SDK with `bun --preload ./telemetry.ts run app.ts`. Bun's HTTP exporter compatibility is good; if you hit an issue, fall back to `node` for the bootstrap process.

## Route handlers and business operations

Use the native API; reach for `withSpan` from `@maple/otel-helpers` for bounded operations.

```ts
import { trace, metrics } from "@opentelemetry/api"
import { withSpan } from "@maple/otel-helpers"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const submitted = meter.createCounter("orders.submitted")

app.post("/orders", async (req, res) => {
	await withSpan(
		"order.submit",
		async (span) => {
			span.setAttributes({
				"tenant.id": req.headers["x-tenant-id"] as string,
				"order.id": req.body.id,
			})
			await chargeOrder(req.body)
			submitted.add(1, { "tenant.id": req.headers["x-tenant-id"] as string })
			res.json({ ok: true })
		},
		{ tracer },
	)
})
```

## Logs

Bridge the existing logger (Pino, Winston, console) through OTLP rather than replacing it. For Pino, install `@opentelemetry/instrumentation-pino` and include it in `instrumentations`. For Winston, install `@opentelemetry/instrumentation-winston`. The user's logger keeps its current sinks; you're adding OTLP underneath so logs carry `trace_id` / `span_id` and reach Maple. Do not rip out the existing logger.

## Coexistence

If the repo has Sentry, Datadog, New Relic, Honeycomb, Logtail, or a Pino transport, leave them in place. They sit alongside Maple, not instead of it.
