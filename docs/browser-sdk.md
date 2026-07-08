# Browser SDK

`@maple-dev/browser` instruments a website with OpenTelemetry tracing **and** rrweb session replay in a single package. Every span and every replay event is tagged with the same `session.id`, so a trace can link straight to the replay that produced it — and vice versa — with no clock-skew guessing.

> Session Replay is currently in **Beta**.

## Install

```bash
npm install @maple-dev/browser
```

## Quick start

Call `MapleBrowser.init` once, as early as possible in your app's entrypoint:

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public ingest key
	serviceName: "acme-web",
})
```

That single call:

- starts OTel browser tracing, auto-instrumenting `fetch`, exporting to Maple's ingest (`POST /v1/traces`);
- records the session with rrweb, chunking events (~5s / 100KB windows), gzipping them with the native `CompressionStream`, and uploading to `POST /v1/sessionReplays/blob`;
- writes session metadata at start (`active`) and on page hide (`ended`), including the trace ids observed during the session.

The SDK is **best-effort**: network failures in telemetry never throw into your app.

`init()` returns a handle — `{ sessionId, shutdown }` — for reading the active session id and tearing telemetry down. See [Sessions](#sessions).

## Configuration

Every field accepted by `MapleBrowser.init`:

| Option                    | Type      | Default                    | Description                                                                                                                                                                                                                                            |
| ------------------------- | --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ingestKey`               | `string`  | —                          | **Required.** Public ingest key (`maple_pk_...`).                                                                                                                                                                                                      |
| `serviceName`             | `string`  | —                          | **Required.** Service name reported on traces and stored on replay sessions.                                                                                                                                                                           |
| `endpoint`                | `string`  | `https://ingest.maple.dev` | Maple ingest base URL. Override for self-hosted / regional ingest.                                                                                                                                                                                     |
| `serviceNamespace`        | `string`  | —                          | Logical group this service belongs to, emitted as the OTel `service.namespace` resource attribute on traces.                                                                                                                                           |
| `serviceVersion`          | `string`  | —                          | Service version or commit SHA, attached to traces.                                                                                                                                                                                                     |
| `environment`             | `string`  | —                          | Deployment environment, e.g. `"production"`.                                                                                                                                                                                                           |
| `userId`                  | `string`  | —                          | User id attached to the replay session for correlation. See [Identifying users](#identifying-users).                                                                                                                                                   |
| `tracing.enabled`         | `boolean` | `true`                     | Enable OTel browser tracing.                                                                                                                                                                                                                           |
| `tracing.instrumentFetch` | `boolean` | `true`                     | Auto-instrument `fetch()` to create network spans. Set `false` when another tracer (e.g. the Effect client SDK) already instruments requests — those spans feed the session via the published sink, and disabling this avoids duplicate network spans. |
| `replay.enabled`          | `boolean` | `true`                     | Enable rrweb session recording.                                                                                                                                                                                                                        |
| `replay.sampleRate`       | `number`  | `1`                        | Fraction of sessions to record, `0`–`1`. See [Sampling](#sampling).                                                                                                                                                                                    |
| `privacy.maskAllInputs`   | `boolean` | `true`                     | Mask all `<input>` values in the recording.                                                                                                                                                                                                            |
| `privacy.maskAllText`     | `boolean` | `false`                    | Mask all text in the rrweb recording and omit captured click-target text from session events.                                                                                                                                                          |

A fully-specified call:

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	environment: "production",
	serviceVersion: "1.4.2",
	userId: currentUser?.id,
	tracing: { enabled: true, instrumentFetch: true },
	replay: { enabled: true, sampleRate: 1.0 },
	privacy: { maskAllInputs: true, maskAllText: false },
})
```

## Sessions

Every span and replay event the SDK emits is tagged with one **`session.id`** (a
`crypto.randomUUID()` v4), minted on the first `MapleBrowser.init` call. That shared id is
what lets a trace jump to the replay that produced it, and vice versa.

### Storage & continuity

The session is persisted in `sessionStorage` under the key `maple.session`, so it **survives
reloads within a tab**. Because `sessionStorage` is per-tab, **each tab or window gets its own
session** — sessions are never shared across them. When `sessionStorage` is unavailable (e.g.
some private-browsing modes), the SDK falls back to an in-memory record for the life of the
page.

SPA route changes do **not** start a new session — the SDK tracks no router events, so
client-side navigation stays within the same session. Session boundaries are purely
time-based (see below).

### Rotation

A fresh `session.id` is minted when either limit is crossed, whichever comes first:

- **30 minutes idle** — no recorded activity for half an hour rotates the session (the same
  activity-window model PostHog uses).
- **24 hours old** — a hard cap on a single session's lifetime regardless of activity, so a
  tab left open for days doesn't collapse into one giant replay.

While replay is recording, each flushed chunk marks the session active, pushing back the idle
deadline — so a continuously-recording session stays whole.

### Start & end metadata

The SDK writes a small session-metadata row at two points:

- an **`active`** row when recording starts (and again on each reload), and
- an **`ended`** row on page hide / unload — fired on `visibilitychange → hidden` (the
  reliable "leaving" signal on mobile) and `pagehide` (desktop tab close / navigation).

The `ended` row carries the session duration, the click count, and the **trace ids observed
during the session**, which is what powers trace↔replay correlation and the user/session
columns in Maple's session list and detail views. The unload write uses `keepalive`, so it
survives the page going away.

### Accessing the session id

`init()` returns a handle whose `sessionId` is the active session's id — useful for
correlating Maple sessions with your own backend logs:

```ts
const { sessionId } = MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
})

// e.g. forward it on your own requests for correlation
fetch("/api/checkout", { headers: { "x-maple-session": sessionId } })
```

`init()` is idempotent — calling it again returns the same live handle. On the server (SSR /
no `window`) it returns a no-op handle with an empty `sessionId`.

### Teardown

Call `shutdown()` to flush the final replay chunk and tear down tracing + replay. After it
resolves, telemetry is fully stopped and a later `init()` may start a new session — handy when
a single-page app unmounts its telemetry client:

```ts
const maple = MapleBrowser.init({ ingestKey: "maple_pk_...", serviceName: "acme-web" })

// later, on teardown
await maple.shutdown()
```

## Identifying users

Pass `userId` so replays and traces are correlated to a known user — it populates the user column in the Maple session list and detail views, and browser-created spans include `user.id`.

If you don't know the user at init time (e.g. the SDK starts before login resolves), omit it; the session begins anonymous. Once you know who the user is, call `MapleBrowser.identify(userId)` to attach (or replace) the id on the active session. Future session rows read the latest id when they post, and future spans read it when they start.

```ts
// after the user signs in
MapleBrowser.identify(user.id)

// after the user signs out
MapleBrowser.identify(null)
```

## Privacy & masking

`maskAllInputs` is **on by default**, so every `<input>` value is masked before it leaves the browser. Set `maskAllText: true` to additionally mask all rendered text.

For finer control, use rrweb's attribute hooks to block specific elements or subtrees from capture:

- `data-rr-block` attribute, or the `.rr-block` class — block an element and its subtree (rendered as a placeholder).
- `.rr-ignore` class — ignore input events on an element.

```html
<div class="rr-block">
	<!-- never captured in the replay -->
	<CreditCardForm />
</div>
```

## Sampling

To record only a fraction of sessions, set `replay.sampleRate` between `0` and `1`. For example, `0.1` records ~10% of sessions. Tracing is unaffected by this setting.

```ts
MapleBrowser.init({
	ingestKey: "maple_pk_...",
	serviceName: "acme-web",
	replay: { sampleRate: 0.1 },
})
```

## Framework examples

### Plain HTML

```html
<script type="module">
	import { MapleBrowser } from "https://esm.sh/@maple-dev/browser"

	MapleBrowser.init({
		ingestKey: "maple_pk_...",
		serviceName: "acme-web",
	})
</script>
```

### React / Vite / Next.js

Initialize at the top of your client entrypoint (e.g. `main.tsx`, or a client-only module) so it runs once before the app renders:

```ts
// src/maple.ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	serviceName: "acme-web",
	environment: import.meta.env.MODE,
})
```

```ts
// src/main.tsx
import "./maple" // import first, before rendering
import { createRoot } from "react-dom/client"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(<App />)
```

In Next.js, run the import from a client component mounted high in the tree (e.g. the root layout), since the SDK is browser-only.

## Notes

- Replay event blobs live in object storage; only small, queryable metadata is indexed — playback streams blobs directly via signed URLs.
- The SDK is browser-only and best-effort: telemetry network failures never surface to your application.
