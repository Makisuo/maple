---
title: "Server"
description: "Set up the Effect SDK on Node.js, Bun, or Deno with environment-variable auto-detection."
group: "Platforms"
order: 3
sdk: "effect"
---

The server entry point of `@maple-dev/effect-sdk` runs on Node.js, Bun, and Deno. It uses Effect's `Otlp.layerJson` exporter with a background fiber that batches and ships telemetry to Maple's ingest endpoint, and reads its configuration from environment variables when none is passed in.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Node.js</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Bun</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Deno</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

## Quick Start

```typescript
import { Maple } from "@maple-dev/effect-sdk"
import { Effect } from "effect"

const TracerLive = Maple.layer({
	serviceName: "my-effect-app",
})

const program = Effect.gen(function* () {
	yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

The default import (`@maple-dev/effect-sdk`) resolves to the server build under Node.js. You can also import the entry point explicitly:

```typescript
import { Maple } from "@maple-dev/effect-sdk/server"
```

Set `MAPLE_ENDPOINT` and `MAPLE_INGEST_KEY` in your environment and the SDK picks them up automatically. If `MAPLE_ENDPOINT` is unset, the layer becomes a no-op — your app runs without exporting telemetry, which is the right default for local dev.

## Environment Variable Auto-Detection

The server layer resolves configuration from environment variables in this order:

**Ingest endpoint:** `MAPLE_ENDPOINT` → `OTEL_EXPORTER_OTLP_ENDPOINT`

**Ingest key:** `MAPLE_INGEST_KEY`

**Commit SHA** (first match wins):

1. `COMMIT_SHA`
2. `RAILWAY_GIT_COMMIT_SHA`
3. `VERCEL_GIT_COMMIT_SHA`
4. `CF_PAGES_COMMIT_SHA`
5. `RENDER_GIT_COMMIT`

**Deployment environment** (first match wins):

1. `MAPLE_ENVIRONMENT`
2. `RAILWAY_ENVIRONMENT`
3. `VERCEL_ENV`
4. `NODE_ENV`

The SDK also auto-detects the **runtime** (Node.js, Bun, Deno) and **cloud provider** (Railway, Vercel, Cloudflare, Render) and includes them as `maple.runtime` and `maple.provider` resource attributes.

## Deployment Platform Notes

Most managed platforms expose commit SHA and environment automatically — no extra config needed:

| Platform        | Commit SHA env var       | Environment env var   |
| --------------- | ------------------------ | --------------------- |
| Railway         | `RAILWAY_GIT_COMMIT_SHA` | `RAILWAY_ENVIRONMENT` |
| Vercel          | `VERCEL_GIT_COMMIT_SHA`  | `VERCEL_ENV`          |
| Cloudflare Pages| `CF_PAGES_COMMIT_SHA`    | —                     |
| Render          | `RENDER_GIT_COMMIT`      | —                     |
| Self-hosted     | `COMMIT_SHA` (set in CI) | `NODE_ENV`            |

For self-hosted deployments, set `COMMIT_SHA` in your build pipeline and `MAPLE_ENVIRONMENT` (or rely on `NODE_ENV`) at runtime.

## Verify

1. Start your application.
2. Generate some traffic — send a request, trigger an operation.
3. Open the Maple dashboard and check that traces appear in the traces view.

If traces aren't appearing, verify:

- `MAPLE_ENDPOINT` is set correctly.
- `MAPLE_INGEST_KEY` is valid.
- Your application can reach `ingest.maple.dev` (or your self-hosted URL).
