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
