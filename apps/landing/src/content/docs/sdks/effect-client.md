---
title: "Browser"
description: "Set up the Effect SDK in browser environments with explicit configuration and auto-captured browser metadata."
group: "Platforms"
order: 4
sdk: "effect"
---

The browser entry point of `@maple-dev/effect-sdk` runs in single-page apps and any other browser context. Unlike the server build, all configuration must be passed to `Maple.layer()` directly — browsers don't have access to `process.env`, so there's nothing to auto-detect.

<div class="flex flex-wrap gap-2 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
</div>

> Already installed the SDK? If not, see the [install instructions](/docs/sdks/effect#install).

## Quick Start

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

The `/client` import is required — the bare `@maple-dev/effect-sdk` import resolves to the server build under Node's conditional exports.

## Auto-Captured Browser Attributes

The client layer reads from `globalThis.navigator` and `Intl.DateTimeFormat` to populate resource attributes automatically:

- `browser.user_agent` — `navigator.userAgent`
- `browser.language` — `navigator.language`
- `browser.timezone` — `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `maple.sdk.type` — always `"client"`, so server- and browser-emitted spans can be filtered apart

Add your own attributes via the `attributes` config option — they're merged on top of the auto-captured ones.

## Use a Public Ingest Key

The browser exposes whatever key you ship in your bundle. **Never put a private/secret ingest key in client code.** Generate a public ingest key (prefix `maple_pk_...`) in your Maple project settings — these keys are scoped to telemetry ingest only and can't read data back out.

## Bundle Size

The `/client` entry point tree-shakes out the Node-only resource detector and platform-attribute helpers, so your bundle only ships the OTLP JSON exporter and Effect's tracer/logger primitives. The peer dependency on `effect` is unavoidable — if your app already uses Effect on the client, the SDK adds only the OTel layer code on top.

## Configuration Reference

See the full [configuration table](/docs/sdks/effect#configuration-reference) on the Effect SDK page. For the browser entry point, `serviceName` and `endpoint` are both required.
