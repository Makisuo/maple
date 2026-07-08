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

## Session Replay & Sessions

The browser presets (`Maple.layer` and `MapleFlush.make`) record **rrweb session replays by default** — no separate browser SDK required. Every span carries a `session.id`, the session appears in [Sessions](/docs/session-replay/browser-sdk) with its linked traces, and the recording plays back next to them.

```typescript
const TracerLive = Maple.layer({
	serviceName: "my-frontend",
	endpoint: "https://ingest.maple.dev",
	ingestKey: "maple_pk_...",
	replay: {
		sampleRate: 0.1, // record 10% of sessions (default 1)
	},
})
```

| Option                 | Default | Description                                                                       |
| ---------------------- | ------- | --------------------------------------------------------------------------------- |
| `replay.enabled`       | `true`  | Record rrweb session replays.                                                     |
| `replay.sampleRate`    | `1`     | Fraction of sessions to record, 0–1.                                              |
| `replay.maskAllInputs` | `true`  | Mask all `<input>` values in the recording.                                       |
| `replay.maskAllText`   | `false` | Mask all text in the recording.                                                   |
| `emitSessionMeta`      | `true`  | Post session metadata rows so unrecorded sessions still appear in the Sessions UI. |

How it behaves:

- **Sampling still yields sessions.** When replay is disabled or a session isn't sampled, the SDK still posts session metadata rows — the session shows up in the Sessions UI with its linked traces, just without a recording. Set `emitSessionMeta: false` to turn that off too.
- **Tab lifecycle.** Recording suspends when the tab is hidden (flushing the tail with `keepalive`) and resumes when it becomes visible again. Sessions survive reloads within a tab and rotate after 30 minutes of inactivity (24-hour hard cap).
- **Identify users** at any point; the id is attached when the session's next metadata row is posted and stamped as `user.id` on future spans. Pass `null` or `undefined` after sign-out to make future telemetry anonymous again:

```typescript
import { identify } from "@maple-dev/effect-sdk/client"

identify(user.id)
identify(null)
```

- **Clear the identity** on logout with `clearIdentity()` (the explicit inverse of `identify()`); metadata rows and spans go back to anonymous while the session continues:

```typescript
import { clearIdentity } from "@maple-dev/effect-sdk/client"

clearIdentity()
```

- **Interop with `@maple-dev/browser`.** If the standalone browser SDK is also on the page, it owns the session — this SDK's recorder and row emission stand down automatically, and spans link to that session instead. Run replay from one SDK, not both.

## Use a Public Ingest Key

The browser exposes whatever key you ship in your bundle. **Never put a private/secret ingest key in client code.** Generate a public ingest key (prefix `maple_pk_...`) in your Maple project settings — these keys are scoped to telemetry ingest only and can't read data back out.

## Bundle Size

The `/client` entry point tree-shakes out the Node-only resource detector and platform-attribute helpers, so your base bundle only ships the OTLP JSON exporter and Effect's tracer/logger primitives (~13 kB). The replay engine — rrweb included — sits behind a dynamic import in a code-split chunk (~360 kB) that is only fetched when replay is enabled *and* the session is sampled; apps that set `replay: { enabled: false }` never download it. The peer dependency on `effect` is unavoidable — if your app already uses Effect on the client, the SDK adds only the OTel layer code on top.

## Configuration Reference

See the full [configuration table](/docs/sdks/effect#configuration-reference) on the Effect SDK page. For the browser entry point, `serviceName` and `endpoint` are both required.
