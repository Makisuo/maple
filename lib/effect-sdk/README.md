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

| Option            | Description                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `dropSpanNames`   | Span names whose prefix matches an entry are dropped before OTLP export (e.g. `"McpServer/Notifications."`) |
| `excludeLogSpans` | Skip Effect log spans in OTLP log attributes. Default `false`                                               |
| `tracesPath`      | OTLP traces path appended to `endpoint`. Default `/v1/traces`                                               |
| `logsPath`        | OTLP logs path appended to `endpoint`. Default `/v1/logs`                                                   |

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

### Session replay & sessions (built in)

The browser presets (`Maple.layer` and `MapleFlush.make`) record **rrweb session replays by default** — no separate browser SDK needed. Every span carries a `session.id`, the session appears in Maple's Sessions UI with its linked traces, and the recording is playable next to them.

```typescript
const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "maple_pk_...",
	replay: {
		sampleRate: 0.1, // record 10% of sessions (default 1)
		maskAllInputs: true, // default
		maskAllText: false, // default
	},
})
```

- **Bundle size:** the replay engine (rrweb included) loads through a dynamic import, so it lands in a code-split chunk (~360 kB) fetched only when replay is enabled *and* the session is sampled. The base client bundle stays ~13 kB.
- **Opt out** with `replay: { enabled: false }`. Unsampled or disabled sessions still appear in the Sessions UI (metadata rows + linked traces, no recording); turn that off too with `emitSessionMeta: false`.
- **Tab lifecycle:** recording suspends on `visibilitychange → hidden` (flushing the tail with `keepalive`) and resumes when the tab becomes visible again, rotating to a fresh session after 30 minutes of inactivity.
- **Identify users** at any point — the id is attached to the session's next-posted metadata row _and_ stamped as `user.id` on every span the client tracer creates from then on (traces become user-attributable, not just session-grouped). Spans created before you call it stay anonymous. Pass `null` or `undefined` after sign-out to make future telemetry anonymous again.

```typescript
import { identify } from "@maple-dev/effect-sdk/client"

identify(user.id)
identify(null)
```

Inside an Effect program (e.g. once a login flow resolves the user) use the Effect-returning form:

```typescript
import { Maple } from "@maple-dev/effect-sdk/client"

yield* Maple.identify(user.id)
```

- **Clear the identity** on logout with `clearIdentity()` — the explicit inverse of `identify()`. Metadata rows and spans go back to anonymous (no `user.id`) from then on; the session itself continues.

```typescript
import { clearIdentity } from "@maple-dev/effect-sdk/client"

clearIdentity()

// or, inside an Effect program:
import { Maple } from "@maple-dev/effect-sdk/client"
yield* Maple.clearIdentity
```

If `@maple-dev/browser` is also on the page, it owns the session and this SDK's replay/emission stands down automatically — exactly one recorder runs, and spans link to that session via the shared sink. Use one or the other for replay, not both.

## Manual flush

`Maple.layer` (server + client) batches in the background and only exports on a timer, on batch overflow, or when its scope closes — there's no way to force an export. That's a problem in two places: a browser tab dropping the last few seconds of spans on unload, and a short-lived process exiting before the timer fires.

`MapleFlush.make()` (available from both `/server` and `/client`) swaps the background exporter for the same buffer-backed tracer/logger the Cloudflare preset uses, and returns an explicit `flush()`:

```typescript
export interface FlushableTelemetry {
	readonly layer: Layer.Layer<never>
	readonly flush: () => Promise<void> // drain buffers → POST now (never rejects)
	readonly dispose: () => Promise<void> // stop the auto-flush timer/listeners + final flush
}
```

Both presets run a background auto-flush every 5s by default (configurable via `autoFlushInterval`, or `false` to flush purely on demand), so it's a safe drop-in for `Maple.layer` with manual flush layered on top.

> **Limitation:** the flushable presets export traces + logs only — no metrics (unlike `Maple.layer`'s `Otlp.layerJson`).

### Server / Node

```typescript
import { MapleFlush } from "@maple-dev/effect-sdk/server"

const telemetry = MapleFlush.make({ serviceName: "my-app" }) // same env auto-detect as Maple.layer

// ...provide telemetry.layer to your runtime...
await telemetry.flush() // force an export at a checkpoint
await telemetry.dispose() // before exit: stop the timer + final flush
```

### Client / Browser

```typescript
import { MapleFlush } from "@maple-dev/effect-sdk/client"

const telemetry = MapleFlush.make({
	serviceName: "my-frontend",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "maple_pk_...",
	// flushOnUnload: true (default) registers pagehide / visibilitychange→hidden handlers
})
// telemetry.layer keeps the replay-session trace linking from Maple.layer.
```

By default the client preset flushes on `pagehide` and `visibilitychange→hidden` so the tail of a session isn't lost when the tab goes away. Flush uses `fetch(url, { keepalive: true })`, **not** `navigator.sendBeacon`: Maple's ingest authenticates via the `Authorization` header (no query-param auth) and sendBeacon can't set headers, so it would 401 whenever an ingest key is set. `keepalive` carries the header and still survives unload for small bodies.

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

Client-only options:

| Option                | Default | Description                                                                          |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| `replay.enabled`      | `true`  | Record rrweb session replays (lazy code-split chunk)                                 |
| `replay.sampleRate`   | `1`     | Fraction of sessions to record, 0–1                                                  |
| `replay.maskAllInputs`| `true`  | Mask all `<input>` values in the recording                                           |
| `replay.maskAllText`  | `false` | Mask all text in the recording                                                       |
| `emitSessionMeta`     | `true`  | Post session metadata rows so unrecorded sessions still appear in the Sessions UI    |

## License

MIT
