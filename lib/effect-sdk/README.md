# @maple-dev/effect-sdk

OpenTelemetry traces, logs, and metrics for [Effect](https://effect.website) applications, powered by [Maple](https://maple.dev).

## Install

```bash
npm install @maple-dev/effect-sdk effect
```

## Server

Auto-detects commit SHA and deployment environment from common platform env vars (Railway, Vercel, Cloudflare Pages, Render). Returns a no-op layer when no endpoint is configured, making it safe for local development.

```typescript
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect } from "effect"

const TracerLive = Maple.layer({ serviceName: "my-app" })

const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

### Environment Variables

| Variable            | Description                     |
| ------------------- | ------------------------------- |
| `MAPLE_ENDPOINT`    | Maple ingest endpoint URL       |
| `MAPLE_INGEST_KEY`  | Maple ingest key                |
| `MAPLE_ENVIRONMENT` | Deployment environment override |

Commit SHA is auto-detected from `COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, or `RENDER_GIT_COMMIT`.

Environment is auto-detected from `MAPLE_ENVIRONMENT`, `RAILWAY_ENVIRONMENT`, `VERCEL_ENV`, or `NODE_ENV`.

## Cloudflare Workers

The Workers preset uses a custom flushable tracer + Effect logger — Workers don't run Node-style background tasks, so spans and logs are buffered in-isolate and drained inside `ctx.waitUntil()` after each request. Construct once at module scope; `flush(env)` resolves env lazily on the first call.

```typescript
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "my-worker",
	// Optional: drop noisy spans before they hit OTLP (prefix match).
	// dropSpanNames: ["McpServer/Notifications."],
})

const handler = HttpRouter.toWebHandler(Routes.pipe(Layer.provideMerge(telemetry.layer)))

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const res = await handler(req)
		ctx.waitUntil(telemetry.flush(env))
		return res
	},
}
```

`telemetry.layer` MUST live in the same runtime as your routes — provide it to the layer composition you hand to `HttpRouter.toWebHandler`, not a separate per-request runtime, or your spans won't pick up the Tracer reference.

When `MAPLE_INGEST_KEY` is unset, the SDK runs in no-op mode: buffers are drained so they don't grow across the isolate's lifetime, but no requests are made. After a flush failure, each signal sleeps 60s before retrying so a broken collector doesn't get hammered.

### Cloudflare-specific options

| Option            | Description                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `dropSpanNames`   | Span names whose prefix matches an entry are dropped before OTLP export (e.g. `"McpServer/Notifications."`) |
| `excludeLogSpans` | Skip Effect log spans in OTLP log attributes. Default `false`                                             |
| `tracesPath`      | OTLP traces path appended to `endpoint`. Default `/v1/traces`                                            |
| `logsPath`        | OTLP logs path appended to `endpoint`. Default `/v1/logs`                                                |

The same `MAPLE_ENDPOINT` / `MAPLE_INGEST_KEY` / `MAPLE_ENVIRONMENT` env vars apply, read from the Workers `env` binding.

## Client (Browser)

All configuration must be provided programmatically since browsers don't have access to environment variables.

```typescript
import { Maple } from "@maple-dev/effect-sdk/client"
import { Effect } from "effect"

const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "maple_pk_...",
})

const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

## Configuration

Both server and client layers accept these options:

| Option                  | Required                                | Description                        |
| ----------------------- | --------------------------------------- | ---------------------------------- |
| `serviceName`           | Yes                                     | Service name reported in telemetry |
| `endpoint`              | Server: env or config, Client: required | Maple ingest endpoint URL          |
| `ingestKey`             | No                                      | Maple ingest key                   |
| `serviceVersion`        | No                                      | Override auto-detected commit SHA  |
| `environment`           | No                                      | Override auto-detected environment |
| `attributes`            | No                                      | Additional resource attributes     |
| `maxBatchSize`          | No                                      | Max batch size for export          |
| `tracerExportInterval`  | No                                      | Trace export interval              |
| `loggerExportInterval`  | No                                      | Log export interval                |
| `metricsExportInterval` | No                                      | Metrics export interval            |
| `shutdownTimeout`       | No                                      | Graceful shutdown timeout          |

## License

MIT
