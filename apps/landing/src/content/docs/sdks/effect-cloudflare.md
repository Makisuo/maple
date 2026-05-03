---
title: "Cloudflare Workers"
description: "Set up the Effect SDK on Cloudflare Workers with explicit flush() in ctx.waitUntil and in-isolate buffering."
group: "Platforms"
order: 5
sdk: "effect"
---

The `/cloudflare` entry point of `@maple-dev/effect-sdk` is built specifically for Cloudflare Workers. Workers don't have a long-running process — your isolate handles a request, returns a response, and the runtime may put it to sleep at any moment. The default `Otlp.layerJson` background-export fiber doesn't tick reliably between invocations, so the Cloudflare build replaces it with explicit, in-isolate buffering and an `flush(env)` call you schedule via `ctx.waitUntil`.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Cloudflare Workers</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

## Why Workers Are Different

- **No background fiber** — spans and logs accumulate in memory inside the isolate and only ship when you call `flush()`.
- **Lazy env resolution** — `make()` is constructible at module scope without `env`. The SDK resolves endpoint, ingest key, and resource attributes on the first `flush(env)` call.
- **Manual lifecycle** — `ctx.waitUntil(telemetry.flush(env))` extends the isolate just long enough to POST the batch after the response is sent.

## Quick Start

```typescript
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { HttpRouter } from "effect/unstable/http"
import { Layer } from "effect"
import { Routes } from "./routes"

const telemetry = MapleCloudflareSDK.make({ serviceName: "my-worker" })

const handler = HttpRouter.toWebHandler(
    Routes.pipe(Layer.provideMerge(telemetry.layer)),
)

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext) {
        const res = await handler(req)
        ctx.waitUntil(telemetry.flush(env))
        return res
    },
}
```

The `telemetry.layer` must be merged into the same Effect runtime that runs your routes — the Tracer reference has to be in scope when spans are created. Using a separate per-request runtime won't work.

## No-Op Mode

When `MAPLE_INGEST_KEY` is unset, the SDK runs in no-op mode: buffers are still drained on each `flush()` call so they don't grow unbounded across the isolate's lifetime, but no POST is made. The first call logs a single `console.info` line so you know telemetry is disabled. This makes the same code safe to deploy to preview environments without an ingest key.

## Failure Handling

If a flush fails (network error, 5xx from the collector), the affected signal goes into a 60-second cooldown — subsequent flushes for that signal skip the POST and log a warning instead. This prevents a broken collector from getting hammered with retries on every request. Errors are caught and logged to `console.error`; they never bubble up into your handler.

## Cloudflare-Specific Config

In addition to the [common options](/docs/sdks/effect#configuration-reference), `make()` accepts a few Workers-specific knobs:

| Option            | Type                  | Default        | Description                                                              |
| ----------------- | --------------------- | -------------- | ------------------------------------------------------------------------ |
| `excludeLogSpans` | `boolean`             | `false`        | Skip Effect log spans in OTLP log attributes                             |
| `dropSpanNames`   | `ReadonlyArray<string>` | —            | Drop spans whose name starts with any prefix in this list                |
| `tracesPath`      | `string`              | `/v1/traces`   | OTLP traces path appended to `endpoint`                                  |
| `logsPath`        | `string`              | `/v1/logs`     | OTLP logs path appended to `endpoint`                                    |

`dropSpanNames` is useful for suppressing protocol-level chatter — e.g. `["McpServer/Notifications."]` to drop MCP notification spam without dropping legitimate handler spans.

## Endpoint Resolution

Endpoint resolution falls back through:

1. `config.endpoint`
2. `env.MAPLE_ENDPOINT`
3. `env.OTEL_EXPORTER_OTLP_ENDPOINT`
4. `https://ingest.maple.dev` (default)

For most users on hosted Maple, providing only `MAPLE_INGEST_KEY` as a Worker secret is enough — the endpoint defaults to the public ingest URL.

## Verify

1. Deploy your Worker (`wrangler deploy`) with `MAPLE_INGEST_KEY` set as a secret.
2. Hit the Worker — you'll see `[MapleCloudflareSDK] traces flushed N record(s) to ...` in the Worker logs (`wrangler tail`).
3. Open the Maple dashboard and check that traces appear.

If nothing shows up, check `wrangler tail` for `[MapleCloudflareSDK]` lines. Common issues:

- `MAPLE_INGEST_KEY` set as a plain env var instead of a secret (use `wrangler secret put MAPLE_INGEST_KEY`).
- `ctx.waitUntil(telemetry.flush(env))` not called — without it, the isolate exits before the POST completes.
- A custom `endpoint` pointing at a host the Worker can't reach.
