# @maple-dev/browser

Browser SDK for [Maple](https://maple.dev) — OpenTelemetry tracing **and** rrweb
session replay in a single package. Every span and every replay event is tagged
with the same `session.id`, so a trace can link straight to the replay that
produced it (and vice versa) with no clock-skew guessing.

## Install

```bash
npm install @maple-dev/browser
```

## Usage

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	ingestKey: "maple_pk_...", // public ingest key
	serviceName: "acme-web",
	environment: "production",
	replay: { enabled: true, sampleRate: 1.0 },
	privacy: { maskAllInputs: true },
})
```

That single call:

- starts OTel browser tracing, auto-instrumenting `fetch`, exporting to Maple's
  ingest (`POST /v1/traces`);
- records the session with rrweb, chunking events (~5s / 100KB windows),
  gzipping them with the native `CompressionStream`, and uploading to
  `POST /v1/sessionReplays/blob`. rrweb ships in a lazy code-split chunk loaded
  only once a session is sampled in, so a `sampleRate` below 1 costs the
  unsampled visitors nothing beyond the ~8 kB gzipped base SDK;
- writes session metadata at start (`active`) and on page hide (`ended`),
  including the trace ids observed during the session.

## Identifying users

Pass `userId` to `init()` when you already know the signed-in user, or call
`MapleBrowser.identify(user.id)` later. The id is attached to future session
metadata rows and stamped as `user.id` on future browser-created spans.

```ts
MapleBrowser.identify(user.id)

// or the full identity — email, name, and the company/team to group by
MapleBrowser.identify({
	id: user.id,
	email: user.email,
	groupId: org.id,
	groupName: org.name,
	traits: { plan: "pro" },
})

// after sign-out
MapleBrowser.identify(null)
```

Each call replaces the identity rather than merging it.

## Custom events

`track(name, props)` records a product event as a `session_events` row with
`Type='custom'`, so it shows up inline in the session transcript rather than in
a separate analytics silo. Calls before `init()` finishes are queued.

```ts
MapleBrowser.track("checkout_completed", { plan: "pro", seats: 12 })
```

## Linking a marketing site to your app

The visitor id lives in localStorage **and** a cookie scoped to your registered
domain, so `example.com` and `app.example.com` resolve to the same `VisitorId`
and an anonymous pre-signup visit links to the account it becomes. Session ids
stay per-origin; `VisitorId` is the join key. Override the scope with
`privacy.crossSubdomainCookie` / `privacy.cookieDomain`.

## Privacy

`maskAllInputs` (default **on**) masks every `<input>` value. Use rrweb's
attribute hooks (`data-rr-block`, `.rr-block`, `.rr-ignore`) to block elements
or subtrees from capture.

`privacy.requireConsent` holds all capture until `MapleBrowser.setConsent(true)`.
Global Privacy Control is honored by default and suppresses the persistent
visitor id; `doNotTrack` is not, unless `privacy.respectDoNotTrack` is set.

## Notes

- Replay event blobs live in object storage; only small, queryable metadata is
  indexed — playback streams blobs directly via signed URLs.
- The SDK is best-effort: network failures in telemetry never throw into your
  app.
