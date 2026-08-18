// Published SDK version, stamped as `x-maple-sdk: maple-browser/<version>` on
// every request to ingest — the OTLP exporter and every session/replay POST —
// so ingest can tell SDK builds apart (`maple.sdk` on the request span). That
// is how a malformed request gets traced back to a release, and how we find
// out whether a fix actually reached users.
//
// A literal rather than a `package.json` import: this ships to browsers, and a
// JSON import would force every consuming bundler to handle JSON modules.
// `version.test.ts` asserts it stays in sync with `package.json`, so a
// hand-bump that forgets it fails CI instead of shipping.
export const SDK_VERSION = "0.3.0"

/** The `x-maple-sdk` value this build sends. */
export const SDK_NAME = "maple-browser"
