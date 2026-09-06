# @maple-dev/effect-sdk

OpenTelemetry traces, logs, and metrics for [Effect](https://effect.website) applications, powered by [Maple](https://maple.dev).

## Install

```bash
npm install @maple-dev/effect-sdk effect
```

## Server

Auto-detects commit SHA and deployment environment from common platform env vars (Railway, Vercel, Cloudflare Pages, Render).

`Maple.layer` always exports. The endpoint defaults to the public Maple ingest (`https://ingest.maple.dev`), so supplying an ingest key is usually all you need. A missing key does **not** switch export off — that keeps keyless setups working against a local `maple start` sink or your own OTLP collector. Keyless against the public ingest is the one combination that can't work (it 401s), and it logs a one-shot warning.

> `MapleFlush.make` and the Cloudflare `make()` behave differently: they **do** no-op when no ingest key resolves. Reach for those if you want telemetry to disable itself automatically.

```typescript
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect } from "effect"

const TracerLive = Maple.layer({ serviceName: "my-app" })

const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))

Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
```

### Environment Variables

| Variable                      | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| `MAPLE_INGEST_KEY`            | Maple ingest key. Required by the public ingest                  |
| `MAPLE_ENDPOINT`              | Ingest endpoint URL. Defaults to `https://ingest.maple.dev`      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Endpoint fallback, honored when `MAPLE_ENDPOINT` is unset        |
| `MAPLE_ENVIRONMENT`           | Deployment environment override                                  |
| `MAPLE_REPOSITORY_URL`        | Repository URL, emitted as `vcs.repository.url.full`             |
| `OTEL_SERVICE_NAME`           | Service name fallback when `serviceName` is omitted              |
| `OTEL_RESOURCE_ATTRIBUTES`    | Extra resource attributes, `key=value` pairs (later writers win) |

Commit SHA is auto-detected from `COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, or `RENDER_GIT_COMMIT`.

Environment is auto-detected from `MAPLE_ENVIRONMENT`, then `RAILWAY_ENVIRONMENT_NAME`, then `DEPLOYMENT_ENV`, falling back to `"development"`. On platforms outside that list (including Vercel), set `MAPLE_ENVIRONMENT` explicitly — `VERCEL_ENV` and `NODE_ENV` are not read.

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
	// Optional: classify expected 4xx failures as successful spans.
	// anticipatedErrorIdentifiers: ["@my-app/http/NotFoundError"],
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

When `MAPLE_INGEST_KEY` is unset, the SDK runs in no-op mode: buffers are drained so they don't grow across the isolate's lifetime, but no requests are made. After a flush failure, the failed batch is restored ahead of newer telemetry and that signal sleeps 60s before retrying. Trace and log cooldowns are independent.

### Cloudflare-specific options

| Option                        | Description                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anticipatedErrorIdentifiers` | Stable `_tag` / `Error.name` identifiers for expected 4xx failures; exported as `Ok` without an exception. A failure wrapped in an `{ error: … }` envelope is matched on the body's `_tag`, so an error decoded from an HTTP response classifies the same as the class that raised it |
| `dropSpanNames`               | Span names whose prefix matches an entry are dropped before OTLP export (e.g. `"McpServer/Notifications."`)                                                                                                                                                                           |
| `excludeLogSpans`             | Skip Effect log spans in OTLP log attributes. Default `false`                                                                                                                                                                                                                         |
| `tracesPath`                  | OTLP traces path appended to `endpoint`. Default `/v1/traces`                                                                                                                                                                                                                         |
| `logsPath`                    | OTLP logs path appended to `endpoint`. Default `/v1/logs`                                                                                                                                                                                                                             |

The same `MAPLE_ENDPOINT` / `MAPLE_INGEST_KEY` / `MAPLE_ENVIRONMENT` env vars apply, read from the Workers `env` binding.

Server spans follow the OTEL HTTP semantic conventions for status: a 5xx response marks the span `Error` (with an `HttpServerErrorResponse` exception event) even when the handler returned it as a plain response — which is what `HttpRouter.toWebHandler` and alchemy's Worker bridge do with a defect — while 4xx responses stay `Ok`.

### alchemy Workers

Alchemy's Worker bridge owns the request lifecycle: it traces every fetch with Effect's HTTP tracer, opens a scope per event and closes it after the response through `ctx.waitUntil`. `telemetry.requestLayer` plugs into that — the same exporters plus a flush when the scope closes — so there is no `waitUntil` to write:

```typescript
import * as Telemetry from "alchemy/Telemetry"

export default class Api extends Cloudflare.Worker<Api>()(
	"api",
	props,
	Effect.gen(function* () {
		// ...
		return { fetch: HttpRouter.toHttpEffect(AppLayer) }
	}).pipe(Effect.provide(Telemetry.layer(telemetry.requestLayer))),
) {}
```

`@maple-dev/alchemy/telemetry` wraps this as `Maple.Telemetry({ serviceName, ingestKey })`, which also binds the ingest key onto the Worker at deploy time.

## Client (Browser and React Native)

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

### React Native

Use the explicit `@maple-dev/effect-sdk/client` entry point with a compatible
Effect 4 version (see `peerDependencies`). `Maple.layer` and `MapleFlush.make`
can export Effect traces, logs, and metrics using the runtime's `fetch`,
`TextEncoder`, and `TextDecoder`. `identify()` and `clearIdentity()` still
control `user.id` on Effect spans.

React Native's `window` does not imply a browser DOM. Browser sessions, replay,
and automatic `session.id` linking are skipped when `document` is absent;
browser session events (`track`) are not exported in this environment. Native
app lifecycle flushing and global native error capture require integration by
the host app; the browser handlers below do not provide those integrations.

Regression coverage uses React Native-shaped globals and the real OTLP layers
with a mocked HTTP transport. It does not certify a particular Expo, Hermes,
or device version.

### Uncaught errors (built in)

`MapleFlush.make` from `/client` registers `error` and `unhandledrejection`
handlers, so a throw that never went through an Effect span still reaches error
tracking. Each one becomes a span with status `Error` and an `exception` event —
the same shape a failed Effect span produces, so browser crashes group beside
server-side errors rather than in a silo.

Turn it off with `captureGlobalErrors: false` when another tracker already owns
the page's global handlers.

An error your app _catches_ never reaches those handlers — catching it is what
stops it. Report those explicitly; a React error boundary is the usual caller,
and without this a boundary-caught crash is invisible in production:

```typescript
const telemetry = MapleFlush.make({ serviceName: "my-frontend", ... })

class ErrorBoundary extends Component<Props, State> {
	componentDidCatch(error: unknown, info: ErrorInfo) {
		telemetry.captureException(error, {
			name: "browser.react_error_boundary",
			attributes: { "maple.react.component_stack": info.componentStack ?? "" },
		})
	}
	// …
}
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

- **Bundle size:** the replay engine (rrweb included) loads through a dynamic import, so it lands in a code-split chunk (~360 kB) fetched only when replay is enabled _and_ the session is sampled. The base client bundle stays ~13 kB.
- **Vendored dependency:** rrweb (MIT) is bundled into that chunk rather than declared in `dependencies`, so it will not appear in your lockfile or in `npm ls` output. Note it directly if your license or supply-chain audit enumerates transitive packages.
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

yield * Maple.identify(user.id)
```

- **Clear the identity** on logout with `clearIdentity()` — the explicit inverse of `identify()`. Metadata rows and spans go back to anonymous (no `user.id`) from then on; the session itself continues.

```typescript
import { clearIdentity } from "@maple-dev/effect-sdk/client"

clearIdentity()

// or, inside an Effect program:
import { Maple } from "@maple-dev/effect-sdk/client"
yield * Maple.clearIdentity
```

- **Identify with the full identity**, not just an id — email, name, and the company/team the Sessions UI groups by. Each call replaces the identity rather than merging it (merging would leak a signed-out user's email into whoever signs in next on a shared device).

```typescript
identify({
	id: user.id,
	email: user.email,
	groupId: org.id,
	groupName: org.name,
	traits: { plan: "pro" },
})
```

- **Custom events** with `track(name, props)` — recorded as a `session_events` row with `Type='custom'`, so a product event reads inline in the session transcript next to the clicks and requests around it. Calls made before the client finishes starting are queued.

```typescript
import { track } from "@maple-dev/effect-sdk/client"

track("checkout_completed", { plan: "pro", seats: 12 })

// or, inside an Effect program:
yield * Maple.track("checkout_completed", { plan: "pro" })
```

- **Cross-subdomain visitors.** The persistent visitor id lives in localStorage _and_ a cookie scoped to your registered domain, so a marketing site on `example.com` and the app on `app.example.com` resolve to the same `VisitorId` — that is what links an anonymous pre-signup visit to the account it becomes. Session ids stay per-origin. Scope it with `privacy: { crossSubdomainCookie, cookieDomain }`.

- **Consent.** `privacy: { requireConsent: true }` holds all capture until `setConsent(true)`; Global Privacy Control is honored by default and suppresses the persistent visitor id.

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

Both presets run a background auto-flush every 5s by default (configurable via `autoFlushInterval`, or `false` to flush purely on demand), so it's a safe drop-in for `Maple.layer` with manual flush layered on top. Effect metrics are cumulative, but the flushable presets only post a new snapshot after a metric changes; an unchanged registry does not generate a metrics request on every flush tick.

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

| Option                  | Required                             | Description                                           |
| ----------------------- | ------------------------------------ | ----------------------------------------------------- |
| `serviceName`           | Yes                                  | Service name reported in telemetry                    |
| `endpoint`              | No (server: defaults) / Yes (client) | Maple ingest endpoint URL                             |
| `ingestKey`             | Required by the public ingest        | Maple ingest key. Flushable presets no-op without one |
| `serviceVersion`        | No                                   | Override auto-detected commit SHA                     |
| `serviceNamespace`      | No                                   | Logical group, emitted as `service.namespace`         |
| `repositoryUrl`         | No (server / Cloudflare only)        | Repository URL, emitted as `vcs.repository.url.full`  |
| `environment`           | No                                   | Override auto-detected environment                    |
| `attributes`            | No                                   | Additional resource attributes (highest precedence)   |
| `maxBatchSize`          | No                                   | Max batch size for export                             |
| `tracerExportInterval`  | No                                   | Trace export interval                                 |
| `loggerExportInterval`  | No                                   | Log export interval                                   |
| `metricsExportInterval` | No                                   | Metrics export interval                               |
| `shutdownTimeout`       | No                                   | Graceful shutdown timeout                             |

The flushable presets (`MapleFlush.make`, and the Cloudflare `make`) replace the
four interval options with `autoFlushInterval`, and add `excludeLogSpans`,
`dropSpanNames`, `anticipatedErrorIdentifiers`, `tracesPath`, `logsPath`, and
`metricsPath`.

> **`anticipatedErrorIdentifiers` is flushable/Cloudflare-only.** `Maple.layer`
> builds on Effect's stock `Otlp.layerJson`, which has no hook for it — so with
> the plain server layer, expected 4xx failures still export as `Error` spans.
> Use `MapleFlush.make` if you need that suppression.

Client-only options:

| Option                 | Default | Description                                                                       |
| ---------------------- | ------- | --------------------------------------------------------------------------------- |
| `replay.enabled`       | `true`  | Record rrweb session replays (lazy code-split chunk)                              |
| `replay.sampleRate`    | `1`     | Fraction of sessions to record, 0–1                                               |
| `replay.maskAllInputs` | `true`  | Mask all `<input>` values in the recording                                        |
| `replay.maskAllText`   | `false` | Mask all text in the recording                                                    |
| `emitSessionMeta`      | `true`  | Post session metadata rows so unrecorded sessions still appear in the Sessions UI |

## License

MIT
