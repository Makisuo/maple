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

Set `MAPLE_INGEST_KEY` in your environment and the SDK picks it up automatically. `MAPLE_ENDPOINT` is optional — it defaults to the public Maple ingest.

The server layer always exports; there is no disable switch. A missing ingest key does not turn export off, so a keyless app pointed at a local `maple start` sink or your own OTLP collector still ships telemetry. The one combination that cannot work is keyless against the public ingest, which rejects unauthenticated writes with a 401 — the SDK logs a one-shot warning if you land there. For local dev that exports nothing at all, either point `MAPLE_ENDPOINT` at a sink you control, or use `MapleFlush.make`, which does no-op without a key.

## Environment Variable Auto-Detection

The server layer resolves configuration from environment variables in this order:

**Ingest endpoint:** `MAPLE_ENDPOINT` → `OTEL_EXPORTER_OTLP_ENDPOINT` → `https://ingest.maple.dev`

**Ingest key:** `MAPLE_INGEST_KEY` — sent as a bearer token; omitted from the request when unset

**Commit SHA** (first match wins):

1. `COMMIT_SHA`
2. `RAILWAY_GIT_COMMIT_SHA`
3. `VERCEL_GIT_COMMIT_SHA`
4. `CF_PAGES_COMMIT_SHA`
5. `RENDER_GIT_COMMIT`

**Deployment environment** (first match wins):

1. `MAPLE_ENVIRONMENT`
2. `RAILWAY_ENVIRONMENT_NAME`
3. `DEPLOYMENT_ENV`
4. Falls back to `"development"`

`VERCEL_ENV` and `NODE_ENV` are **not** read — on any platform outside that list, set `MAPLE_ENVIRONMENT` explicitly or your telemetry lands under `development`.

The SDK also auto-detects the **runtime** (Node.js, Bun, Deno) and **cloud provider** (Railway, Vercel, Cloudflare, Render) and includes them as `maple.runtime` and `maple.provider` resource attributes.

## Deployment Platform Notes

Managed platforms expose the commit SHA automatically. The **environment** is only auto-detected on Railway — everywhere else, set `MAPLE_ENVIRONMENT` yourself:

| Platform         | Commit SHA env var       | Environment                                 |
| ---------------- | ------------------------ | ------------------------------------------- |
| Railway          | `RAILWAY_GIT_COMMIT_SHA` | `RAILWAY_ENVIRONMENT_NAME` (automatic)      |
| Vercel           | `VERCEL_GIT_COMMIT_SHA`  | Set `MAPLE_ENVIRONMENT`                     |
| Cloudflare Pages | `CF_PAGES_COMMIT_SHA`    | Set `MAPLE_ENVIRONMENT`                     |
| Render           | `RENDER_GIT_COMMIT`      | Set `MAPLE_ENVIRONMENT`                     |
| Self-hosted      | `COMMIT_SHA` (set in CI) | Set `MAPLE_ENVIRONMENT` or `DEPLOYMENT_ENV` |

For self-hosted deployments, set `COMMIT_SHA` in your build pipeline and `MAPLE_ENVIRONMENT` at runtime.

## Server-side `track()`

Some funnel steps only happen on the backend — a `signup_completed` in a webhook handler, a
`plan_started` when billing confirms a subscription. `MapleEvents` posts those to Maple's
[product events endpoint](/docs/session-replay/product-events-api) so they land in the same
`product_events` table as the browser SDK's `track()` calls, keyed to the same person.

```typescript
import { MapleEvents } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"

const EventsLive = MapleEvents.layer({ serviceName: "billing" })

const onSubscriptionCreated = Effect.fn("onSubscriptionCreated")(function* (
	userId: string,
	orgId: string,
	plan: string,
) {
	const events = yield* MapleEvents.MapleEvents
	yield* events.track("plan_started", { userId, groupId: orgId, attributes: { plan } })
})
```

`track(name, options)` buffers the event and returns immediately; batches go out every 5 seconds,
at 100 events, and when the layer's scope closes. It never fails the caller — a rejected batch is
dropped with a rate-limited console warning. `options` are all optional: `userId`, `groupId`,
`visitorId` (the browser cookie value, if your backend has it), `sessionId`, `timestamp`, `url`,
`pagePath`, and `attributes` (coerced and capped exactly like the browser `track()`).

The endpoint and ingest key resolve the same way as the tracer (`endpoint`/`ingestKey` in config,
else `MAPLE_ENDPOINT` / `MAPLE_INGEST_KEY`); without a key, events are dropped with a one-shot
warning. Outside an Effect runtime, `MapleEvents.makeHandle(config)` returns a plain
`{ track, flush, dispose }` — call `dispose()` on shutdown so the last batch is sent.

## Verify

1. Start your application.
2. Generate some traffic — send a request, trigger an operation.
3. Open the Maple dashboard and check that traces appear in the traces view.

If traces aren't appearing, verify:

- `MAPLE_ENDPOINT` is set correctly.
- `MAPLE_INGEST_KEY` is valid.
- Your application can reach `ingest.maple.dev` (or your self-hosted URL).
