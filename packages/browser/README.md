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
  `POST /v1/sessionReplays/blob`;
- writes session metadata at start (`active`) and on page hide (`ended`),
  including the trace ids observed during the session.

## Identifying users

Pass `userId` to `init()` when you already know the signed-in user, or call
`MapleBrowser.identify(user.id)` later. The id is attached to future session
metadata rows and stamped as `user.id` on future browser-created spans.

```ts
MapleBrowser.identify(user.id)

// after sign-out
MapleBrowser.identify(null)
```

## Privacy

`maskAllInputs` (default **on**) masks every `<input>` value. Use rrweb's
attribute hooks (`data-rr-block`, `.rr-block`, `.rr-ignore`) to block elements
or subtrees from capture.

## Notes

- Replay event blobs live in object storage; only small, queryable metadata is
  indexed — playback streams blobs directly via signed URLs.
- The SDK is best-effort: network failures in telemetry never throw into your
  app.
