// Published SDK version, stamped into the OTLP export `user-agent` so ingest
// can tell SDK versions apart — which is how we find out whether a fix actually
// reached users.
//
// A literal rather than a `package.json` import: the client entry ships to
// browsers, and a JSON import would force every consuming bundler to handle
// JSON modules. `version.test.ts` asserts this stays in sync with
// `package.json`, so a hand-bump that forgets it fails CI instead of shipping.
export const SDK_VERSION = "0.8.0"

/**
 * `x-maple-sdk` value for the browser client entry — the header equivalent of
 * the `user-agent` above, because a page cannot set `user-agent`. Ingest
 * records it as `maple.sdk`. Server/Cloudflare presets send the same value
 * (their `user-agent` string) so every ingest request carries the hint.
 */
export const CLIENT_SDK_HINT = `maple-effect-sdk-client/${SDK_VERSION}`
