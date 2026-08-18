// Published SDK version, stamped into the OTLP export `user-agent` so ingest
// can tell SDK versions apart — which is how we find out whether a fix actually
// reached users.
//
// A literal rather than a `package.json` import: the client entry ships to
// browsers, and a JSON import would force every consuming bundler to handle
// JSON modules. `version.test.ts` asserts this stays in sync with
// `package.json`, so a hand-bump that forgets it fails CI instead of shipping.
export const SDK_VERSION = "0.7.0"
