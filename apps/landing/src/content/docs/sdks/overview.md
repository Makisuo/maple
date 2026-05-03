---
title: "Overview"
description: "Maple SDKs are official, opinionated wrappers around OpenTelemetry that auto-detect platform conventions."
group: "Effect SDK"
order: 1
sdk: "effect"
---

Maple SDKs are official, hand-built libraries that wrap OpenTelemetry with sensible defaults for the runtimes and platforms we support. They auto-detect commit SHAs, deployment environments, and runtime metadata so you can ship traces, logs, and metrics with a single `layer()` call.

If your language or framework isn't covered here, fall back to the language-generic [Guides](/docs/guides/instrumentation-nodejs) — they walk through standard OpenTelemetry setup pointed at Maple's ingest endpoint.

## Available SDKs

| SDK                                  | Package                  | Platforms                                | Status |
| ------------------------------------ | ------------------------ | ---------------------------------------- | ------ |
| [Effect SDK](/docs/sdks/effect)      | `@maple-dev/effect-sdk`  | Node.js, Bun, Deno, Browsers, Cloudflare | Stable |

<div class="flex flex-wrap gap-2 mt-4 mb-8 not-prose">
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Node.js</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Bun</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Deno</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Browsers</span>
    <span class="text-[10px] uppercase tracking-wider px-2 py-1 border border-border text-fg-muted">Cloudflare Workers</span>
</div>

## What "official SDK" means

A Maple SDK is more than a thin OTel wrapper. Each SDK:

- **Auto-detects platform metadata** — commit SHA, deployment environment, cloud provider, and runtime are picked up from environment variables (Railway, Vercel, Cloudflare Pages, Render, etc.) so you don't have to wire them up by hand.
- **No-ops safely without an endpoint** — if `MAPLE_ENDPOINT` (or the equivalent) isn't set, the layer becomes a no-op. Local development doesn't need a Maple project.
- **Ships with platform-specific entry points** — server, browser, and serverless runtimes get their own builds with the right exporter and lifecycle wiring.
- **Tracks the Maple ingest API** — when we add new resource attributes or signal types on the backend, the SDK gets updated to match.

## Coming soon

We're working on dedicated SDKs for:

- **Node.js / TypeScript** — for apps that don't use Effect.
- **Python** — fastapi, django, generic asyncio.

In the meantime, the [Node.js](/docs/guides/instrumentation-nodejs) and [Python](/docs/guides/instrumentation-python) guides cover the standard OpenTelemetry SDK pointed at Maple.
